"""Protocol-level clients for pulling layers from live services.

The point of this module is that nothing has to be downloaded by hand. Each
client asks a service for **only the study area**, at the working resolution,
and caches the answer under `data/raw/`. For the 1 m LIDAR that is the
difference between a few tens of megabytes and a national dataset.

Every endpoint is declared in `config.yaml`, not here, so correcting a URL, a
layer id, a coverage name or an auth style is a config edit rather than a code
change. Credentials are read from environment variables named in the config and
are never written to disk, logged, or included in the run manifest.

Supported kinds:

* ``arcgis_featureserver``  - ArcGIS REST query, paged (vector)
* ``arcgis_imageserver``    - ArcGIS REST exportImage, tiled and mosaicked (raster)
* ``ogc_wcs``               - OGC Web Coverage Service GetCoverage (raster)
* ``ogc_api_features``      - OGC API - Features, link-paged (vector)
* ``wfs``                   - OGC WFS GetFeature, index-paged (vector)
* ``nbn_occurrences``       - NBN Atlas occurrence search (species records)
"""

from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

import requests

USER_AGENT = "bog-orchid-habitat-model/1.1 (+conservation research)"
TIMEOUT = 180
RETRIES = 4
BACKOFF = 2.0

# ArcGIS image services commonly cap a single exportImage response at ~4100 px
# per side; WCS servers vary. Tiles are requested below any plausible cap and
# mosaicked locally.
MAX_TILE_PIXELS = 2000


class ServiceError(RuntimeError):
    """Raised when a service cannot be used. Carries an actionable message."""


@dataclass(frozen=True)
class Credentials:
    """How to present an API key, if the service needs one."""

    style: str = "none"          # none | query | header | bearer
    param: str = "key"           # query parameter name, for style=query
    header: str = "apikey"       # header name, for style=header
    value: str | None = None

    @classmethod
    def from_config(cls, spec: Mapping[str, Any] | None, key_env: str | None):
        if not key_env:
            return cls()
        value = os.environ.get(key_env)
        if not value:
            raise ServiceError(
                f"this source needs an API key from the environment variable "
                f"{key_env}, which is not set. Export it (or put it in a .env "
                f"file that is not committed) and try again."
            )
        spec = dict(spec or {})
        return cls(
            style=str(spec.get("style", "query")),
            param=str(spec.get("param", "key")),
            header=str(spec.get("header", "apikey")),
            value=value,
        )

    def apply(self, params: dict[str, Any], headers: dict[str, str]) -> None:
        if self.style == "none" or not self.value:
            return
        if self.style == "query":
            params[self.param] = self.value
        elif self.style == "header":
            headers[self.header] = self.value
        elif self.style == "bearer":
            headers["Authorization"] = f"Bearer {self.value}"
        else:
            raise ServiceError(f"unknown auth style {self.style!r}")


def _session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    return session


def request(
    session: requests.Session,
    url: str,
    params: Mapping[str, Any] | None = None,
    credentials: Credentials | None = None,
    expect: str = "json",
) -> Any:
    """One GET with retries, returning parsed JSON or raw bytes.

    Retries only what is worth retrying: timeouts, connection failures and 5xx.
    A 401/403 is a credentials or policy problem and retrying it just wastes
    time and looks like an attack, so it is raised immediately with an
    explanation.
    """
    query = dict(params or {})
    headers: dict[str, str] = {}
    if credentials:
        credentials.apply(query, headers)

    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            response = session.get(url, params=query, headers=headers, timeout=TIMEOUT)
        except (requests.Timeout, requests.ConnectionError) as exc:
            last = exc
            if attempt < RETRIES - 1:
                time.sleep(BACKOFF ** (attempt + 1))
                continue
            raise ServiceError(
                f"could not reach {url} after {RETRIES} attempts: {exc}. If this "
                f"machine is behind a proxy or an egress policy, the host may be "
                f"blocked rather than down."
            ) from exc

        if response.status_code in (401, 403):
            raise ServiceError(
                f"{url} returned {response.status_code}. Either the API key is "
                f"missing/invalid for this service, or outbound access to this "
                f"host is blocked by a network egress policy. Both look identical "
                f"from here - check the key first, then the network."
            )
        if response.status_code == 429:
            time.sleep(BACKOFF ** (attempt + 1))
            last = ServiceError(f"{url} rate-limited the request")
            continue
        if response.status_code >= 500:
            last = ServiceError(f"{url} returned {response.status_code}")
            if attempt < RETRIES - 1:
                time.sleep(BACKOFF ** (attempt + 1))
                continue
        response.raise_for_status()

        if expect == "bytes":
            return response.content
        text = response.text
        try:
            payload = response.json()
        except ValueError as exc:
            raise ServiceError(
                f"{url} did not return JSON. First 300 characters of the "
                f"response: {text[:300]!r}"
            ) from exc
        if isinstance(payload, dict) and "error" in payload:
            raise ServiceError(f"{url} returned an error: {payload['error']}")
        return payload

    raise ServiceError(f"{url} failed: {last}")


# ---------------------------------------------------------------------------
# Vector services
# ---------------------------------------------------------------------------

def fetch_arcgis_featureserver(
    url: str,
    bbox: tuple[float, float, float, float] | None = None,
    where: str | None = None,
    out_sr: int = 27700,
    page_size: int = 1000,
    max_pages: int = 2000,
    credentials: Credentials | None = None,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Page a whole ArcGIS FeatureServer layer into one GeoJSON collection.

    ArcGIS caps a response at ``maxRecordCount`` and flags more with
    ``exceededTransferLimit``; a query that stops at the first page silently
    returns a corner of the study area and nothing else.
    """
    query_url = url.rstrip("/") + "/query"
    params: dict[str, Any] = {
        "f": "geojson",
        "where": where or "1=1",
        "outFields": "*",
        "outSR": out_sr,
        "returnGeometry": "true",
        "resultRecordCount": page_size,
    }
    params.update(dict(extra or {}))
    if bbox is not None:
        params.update(
            {
                "geometry": json.dumps(
                    {
                        "xmin": bbox[0], "ymin": bbox[1],
                        "xmax": bbox[2], "ymax": bbox[3],
                        "spatialReference": {"wkid": out_sr},
                    }
                ),
                "geometryType": "esriGeometryEnvelope",
                "inSR": out_sr,
                "spatialRel": "esriSpatialRelIntersects",
            }
        )

    features: list[dict[str, Any]] = []
    with _session() as session:
        for page in range(max_pages):
            params["resultOffset"] = page * page_size
            payload = request(session, query_url, params, credentials)
            batch = payload.get("features") or []
            features.extend(batch)
            exceeded = (payload.get("properties") or {}).get("exceededTransferLimit")
            if not exceeded and len(batch) < page_size:
                break
        else:
            raise ServiceError(
                f"{query_url}: stopped after {max_pages} pages; narrow the bounding box"
            )
    return {"type": "FeatureCollection", "features": features}


def fetch_ogc_api_features(
    url: str,
    bbox: tuple[float, float, float, float],
    crs: str = "http://www.opengis.net/def/crs/EPSG/0/27700",
    limit: int = 100,
    max_pages: int = 2000,
    credentials: Credentials | None = None,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Page an OGC API - Features collection (e.g. the OS NGD Features API).

    Follows the ``next`` link rather than guessing an offset parameter, which is
    what the standard specifies and what OS actually implements.
    """
    items_url = url.rstrip("/")
    if not items_url.endswith("/items"):
        items_url += "/items"
    params: dict[str, Any] = {
        "bbox": ",".join(f"{v:.3f}" for v in bbox),
        "bbox-crs": crs,
        "crs": crs,
        "limit": limit,
    }
    params.update(dict(extra or {}))

    features: list[dict[str, Any]] = []
    next_url: str | None = items_url
    next_params: dict[str, Any] | None = params
    with _session() as session:
        for _ in range(max_pages):
            if not next_url:
                break
            payload = request(session, next_url, next_params, credentials)
            features.extend(payload.get("features") or [])
            links = payload.get("links") or []
            following = [
                link.get("href") for link in links if link.get("rel") == "next"
            ]
            next_url = following[0] if following and following[0] else None
            # A `next` href already carries its own query string.
            next_params = None
        else:
            raise ServiceError(f"{items_url}: stopped after {max_pages} pages")
    return {"type": "FeatureCollection", "features": features}


def fetch_wfs(
    url: str,
    type_names: str,
    bbox: tuple[float, float, float, float],
    srs: str = "EPSG:27700",
    version: str = "2.0.0",
    page_size: int = 1000,
    max_pages: int = 2000,
    credentials: Credentials | None = None,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Page a WFS GetFeature request. Used for BGS geology."""
    count_key = "count" if version.startswith("2") else "maxFeatures"
    names_key = "typeNames" if version.startswith("2") else "typeName"
    params: dict[str, Any] = {
        "service": "WFS",
        "version": version,
        "request": "GetFeature",
        names_key: type_names,
        "outputFormat": "application/json",
        "srsName": srs,
        "bbox": ",".join(f"{v:.3f}" for v in bbox) + f",{srs}",
        count_key: page_size,
    }
    params.update(dict(extra or {}))

    features: list[dict[str, Any]] = []
    with _session() as session:
        for page in range(max_pages):
            params["startIndex"] = page * page_size
            payload = request(session, url, params, credentials)
            batch = payload.get("features") or []
            features.extend(batch)
            if len(batch) < page_size:
                break
        else:
            raise ServiceError(f"{url}: stopped after {max_pages} pages")
    return {"type": "FeatureCollection", "features": features}


# ---------------------------------------------------------------------------
# Raster services
# ---------------------------------------------------------------------------

def _tiles(
    bbox: tuple[float, float, float, float], resolution: float, max_pixels: int
) -> list[tuple[float, float, float, float]]:
    """Split a bounding box into pieces no larger than ``max_pixels`` per side."""
    minx, miny, maxx, maxy = bbox
    span = max_pixels * resolution
    xs = max(1, math.ceil((maxx - minx) / span))
    ys = max(1, math.ceil((maxy - miny) / span))
    out = []
    for i in range(xs):
        for j in range(ys):
            x0 = minx + i * span
            y0 = miny + j * span
            out.append((x0, y0, min(x0 + span, maxx), min(y0 + span, maxy)))
    return out


def _mosaic(paths: list[Path], destination: Path, crs: str) -> Path:
    import rasterio
    from rasterio.merge import merge

    if len(paths) == 1:
        paths[0].replace(destination)
        return destination

    handles = [rasterio.open(p) for p in paths]
    try:
        array, transform = merge(handles)
        profile = handles[0].profile
        profile.update(
            {
                "height": array.shape[1],
                "width": array.shape[2],
                "transform": transform,
                "count": array.shape[0],
                "crs": crs,
                "compress": "deflate",
                "tiled": True,
            }
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        with rasterio.open(destination, "w", **profile) as dst:
            dst.write(array)
    finally:
        for handle in handles:
            handle.close()
    for path in paths:
        path.unlink(missing_ok=True)
    return destination


def fetch_arcgis_imageserver(
    url: str,
    bbox: tuple[float, float, float, float],
    resolution: float,
    destination: Path,
    out_sr: int = 27700,
    credentials: Credentials | None = None,
    extra: Mapping[str, Any] | None = None,
    interpolation: str = "RSP_BilinearInterpolation",
    max_tile_pixels: int = MAX_TILE_PIXELS,
) -> Path:
    """Stream an ArcGIS ImageServer coverage for the study area only.

    Requested in tiles and mosaicked, because image services cap a single
    response at a few thousand pixels a side and the moor at 10 m is larger
    than that.
    """
    export_url = url.rstrip("/") + "/exportImage"
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    with _session() as session:
        for index, tile in enumerate(_tiles(bbox, resolution, max_tile_pixels)):
            width = max(1, int(round((tile[2] - tile[0]) / resolution)))
            height = max(1, int(round((tile[3] - tile[1]) / resolution)))
            params: dict[str, Any] = {
                "bbox": ",".join(f"{v:.3f}" for v in tile),
                "bboxSR": out_sr,
                "imageSR": out_sr,
                "size": f"{width},{height}",
                "format": "tiff",
                "pixelType": "F32",
                "interpolation": interpolation,
                "f": "image",
            }
            params.update(dict(extra or {}))
            content = request(session, export_url, params, credentials, expect="bytes")
            if not content.startswith((b"II", b"MM")):
                raise ServiceError(
                    f"{export_url} returned {len(content)} bytes that are not a "
                    f"TIFF. First 300 characters: {content[:300]!r}"
                )
            part = destination.with_suffix(f".part{index}.tif")
            part.write_bytes(content)
            written.append(part)

    return _mosaic(written, destination, f"EPSG:{out_sr}")


def fetch_wcs_coverage(
    url: str,
    coverage_id: str,
    bbox: tuple[float, float, float, float],
    resolution: float,
    destination: Path,
    version: str = "2.0.1",
    srs: str = "EPSG:27700",
    credentials: Credentials | None = None,
    extra: Mapping[str, Any] | None = None,
    max_tile_pixels: int = MAX_TILE_PIXELS,
) -> Path:
    """Stream a coverage from an OGC WCS for the study area only."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    epsg = srs.split(":")[-1]
    written: list[Path] = []

    with _session() as session:
        for index, tile in enumerate(_tiles(bbox, resolution, max_tile_pixels)):
            if version.startswith("2"):
                params: dict[str, Any] = {
                    "service": "WCS",
                    "version": version,
                    "request": "GetCoverage",
                    "coverageId": coverage_id,
                    "format": "image/tiff",
                    "subset": [
                        f"x({tile[0]:.3f},{tile[2]:.3f})",
                        f"y({tile[1]:.3f},{tile[3]:.3f})",
                    ],
                    "subsettingCrs": f"http://www.opengis.net/def/crs/EPSG/0/{epsg}",
                    "outputCrs": f"http://www.opengis.net/def/crs/EPSG/0/{epsg}",
                }
            else:
                width = max(1, int(round((tile[2] - tile[0]) / resolution)))
                height = max(1, int(round((tile[3] - tile[1]) / resolution)))
                params = {
                    "service": "WCS",
                    "version": version,
                    "request": "GetCoverage",
                    "coverage": coverage_id,
                    "format": "GeoTIFF",
                    "crs": srs,
                    "bbox": ",".join(f"{v:.3f}" for v in tile),
                    "width": width,
                    "height": height,
                }
            params.update(dict(extra or {}))
            content = request(session, url, params, credentials, expect="bytes")
            if not content.startswith((b"II", b"MM")):
                raise ServiceError(
                    f"{url} returned {len(content)} bytes that are not a TIFF. "
                    f"WCS servers report errors as XML - first 300 characters: "
                    f"{content[:300]!r}"
                )
            part = destination.with_suffix(f".part{index}.tif")
            part.write_bytes(content)
            written.append(part)

    return _mosaic(written, destination, srs)


# ---------------------------------------------------------------------------
# Species records
# ---------------------------------------------------------------------------

def fetch_nbn_occurrences(
    url: str,
    scientific_name: str,
    bbox: tuple[float, float, float, float] | None = None,
    page_size: int = 300,
    max_pages: int = 100,
    credentials: Credentials | None = None,
    extra: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Search the NBN Atlas occurrence service for a species.

    Returns the raw occurrence records. Interpreting them - in particular
    deciding whether a record's coordinate uncertainty is small enough to
    calibrate against - is deliberately left to the caller, because that is an
    ecological judgement and not a parsing one.
    """
    search_url = url.rstrip("/")
    if not search_url.endswith("/search"):
        search_url += "/search"

    params: dict[str, Any] = {
        "q": f'scientificName:"{scientific_name}"',
        "pageSize": page_size,
        "facet": "false",
    }
    if bbox is not None:
        # NBN/ALA spatial filter expects a WKT polygon in WGS84.
        from pyproj import Transformer

        transformer = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
        corners = [
            transformer.transform(bbox[0], bbox[1]),
            transformer.transform(bbox[2], bbox[1]),
            transformer.transform(bbox[2], bbox[3]),
            transformer.transform(bbox[0], bbox[3]),
        ]
        ring = ", ".join(f"{x:.6f} {y:.6f}" for x, y in corners)
        params["wkt"] = f"POLYGON(({ring}, {corners[0][0]:.6f} {corners[0][1]:.6f}))"
    params.update(dict(extra or {}))

    records: list[dict[str, Any]] = []
    with _session() as session:
        for page in range(max_pages):
            params["startIndex"] = page * page_size
            payload = request(session, search_url, params, credentials)
            batch = payload.get("occurrences") or []
            records.extend(batch)
            total = payload.get("totalRecords")
            if not batch or (total is not None and len(records) >= int(total)):
                break
        else:
            raise ServiceError(f"{search_url}: stopped after {max_pages} pages")
    return records


def occurrences_to_frame(records: Iterable[Mapping[str, Any]]):
    """Turn NBN occurrence records into a GeoDataFrame in EPSG:27700.

    Keeps `coordinateUncertaintyInMeters`, because a record is only usable for
    calibration if it is precise relative to the working resolution, and most
    published botanical records are not.
    """
    import geopandas as gpd
    import pandas as pd
    from shapely.geometry import Point

    rows: list[dict[str, Any]] = []
    for record in records:
        latitude = record.get("decimalLatitude")
        longitude = record.get("decimalLongitude")
        if latitude is None or longitude is None:
            continue
        rows.append(
            {
                "uuid": record.get("uuid"),
                "scientific_name": record.get("scientificName"),
                "year": record.get("year"),
                "event_date": record.get("eventDate"),
                "locality": record.get("locality"),
                "dataset": record.get("dataResourceName"),
                "grid_reference": record.get("gridReference"),
                "coordinate_uncertainty_m": record.get("coordinateUncertaintyInMeters"),
                "basis_of_record": record.get("basisOfRecord"),
                "latitude": latitude,
                "longitude": longitude,
            }
        )
    if not rows:
        return gpd.GeoDataFrame(
            columns=["uuid", "scientific_name", "year", "geometry"],
            geometry="geometry",
            crs="EPSG:27700",
        )
    frame = pd.DataFrame(rows)
    points = [Point(x, y) for x, y in zip(frame["longitude"], frame["latitude"])]
    return gpd.GeoDataFrame(frame, geometry=points, crs="EPSG:4326").to_crs("EPSG:27700")
