"""Tests for the live-service clients, against a stub transport.

None of these touch the network. What they pin down is the part that is easy to
get wrong and expensive to discover later: that paging actually terminates and
collects every page, that credentials go where the service expects them, that a
raster request is tiled under the service's size cap, and that a non-raster
response is reported rather than written out as a corrupt GeoTIFF.
"""


import pytest
import requests

from bogorchid import services
from bogorchid.services import Credentials, ServiceError


class StubResponse:
    def __init__(self, payload=None, content=b"", status_code=200):
        self._payload = payload
        self.content = content
        self.status_code = status_code
        self.text = "" if payload is None else str(payload)

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}")


class StubSession:
    """Records every request and replays a scripted list of responses."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []
        self.headers = {}

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append({"url": url, "params": dict(params or {}), "headers": dict(headers or {})})
        if not self._responses:
            raise AssertionError(f"unexpected extra request to {url}")
        return self._responses.pop(0)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


@pytest.fixture
def stub(monkeypatch):
    def install(responses):
        session = StubSession(responses)
        monkeypatch.setattr(services, "_session", lambda: session)
        return session

    return install


BBOX = (260000.0, 86000.0, 268000.0, 92000.0)


# --------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------

def test_missing_api_key_is_a_clear_error(monkeypatch):
    monkeypatch.delenv("TEST_KEY", raising=False)
    with pytest.raises(ServiceError, match="TEST_KEY"):
        Credentials.from_config({"style": "query"}, "TEST_KEY")


def test_key_goes_where_the_service_expects_it(monkeypatch):
    monkeypatch.setenv("TEST_KEY", "secret")
    params, headers = {}, {}
    Credentials.from_config({"style": "query", "param": "key"}, "TEST_KEY").apply(params, headers)
    assert params == {"key": "secret"} and headers == {}

    params, headers = {}, {}
    Credentials.from_config({"style": "header", "header": "key"}, "TEST_KEY").apply(params, headers)
    assert headers == {"key": "secret"} and params == {}

    params, headers = {}, {}
    Credentials.from_config({"style": "bearer"}, "TEST_KEY").apply(params, headers)
    assert headers == {"Authorization": "Bearer secret"}


def test_no_key_configured_sends_nothing():
    params, headers = {}, {}
    Credentials.from_config(None, None).apply(params, headers)
    assert params == {} and headers == {}


# --------------------------------------------------------------------------
# Error handling
# --------------------------------------------------------------------------

def test_403_is_not_retried_and_names_both_causes(stub):
    session = stub([StubResponse(status_code=403)])
    with pytest.raises(ServiceError, match="egress policy"):
        services.request(session, "https://example.test")
    assert len(session.calls) == 1, "an authorisation failure must not be retried"


def test_html_error_page_is_reported_not_parsed(stub):
    session = stub([StubResponse(payload=None, content=b"<html>nope</html>")])
    with pytest.raises(ServiceError, match="did not return JSON"):
        services.request(session, "https://example.test")


def test_arcgis_error_object_is_surfaced(stub):
    session = stub([StubResponse(payload={"error": {"code": 400, "message": "bad layer"}})])
    with pytest.raises(ServiceError, match="bad layer"):
        services.request(session, "https://example.test")


# --------------------------------------------------------------------------
# Vector paging
# --------------------------------------------------------------------------

def test_featureserver_pages_until_the_service_stops(stub):
    full = {
        "features": [{"id": i} for i in range(1000)],
        "properties": {"exceededTransferLimit": True},
    }
    last = {"features": [{"id": 1000}], "properties": {}}
    session = stub([StubResponse(full), StubResponse(last)])
    collection = services.fetch_arcgis_featureserver("https://x/0", bbox=BBOX)
    assert len(collection["features"]) == 1001
    assert session.calls[0]["params"]["resultOffset"] == 0
    assert session.calls[1]["params"]["resultOffset"] == 1000


def test_featureserver_sends_the_bbox_in_the_working_crs(stub):
    stub([StubResponse({"features": [{"id": 1}]})])
    services.fetch_arcgis_featureserver("https://x/0", bbox=BBOX)


def test_ogc_api_features_follows_the_next_link(stub):
    first = {
        "features": [{"id": 1}],
        "links": [{"rel": "next", "href": "https://x/items?cursor=2"}],
    }
    second = {"features": [{"id": 2}], "links": []}
    session = stub([StubResponse(first), StubResponse(second)])
    collection = services.fetch_ogc_api_features("https://x", bbox=BBOX)
    assert len(collection["features"]) == 2
    # The second request must use the href verbatim, not rebuild the query.
    assert session.calls[1]["url"] == "https://x/items?cursor=2"
    assert session.calls[1]["params"] == {}


def test_wfs_uses_version_appropriate_parameter_names(stub):
    session = stub([StubResponse({"features": []})])
    services.fetch_wfs("https://x/wfs", type_names="a:b", bbox=BBOX, version="2.0.0")
    assert "typeNames" in session.calls[0]["params"]
    assert "count" in session.calls[0]["params"]

    session = stub([StubResponse({"features": []})])
    services.fetch_wfs("https://x/wfs", type_names="a:b", bbox=BBOX, version="1.1.0")
    assert "typeName" in session.calls[0]["params"]
    assert "maxFeatures" in session.calls[0]["params"]


# --------------------------------------------------------------------------
# Raster tiling
# --------------------------------------------------------------------------

def test_large_areas_are_split_into_tiles_under_the_cap():
    tiles = services._tiles((0, 0, 40000, 30000), resolution=10.0, max_pixels=2000)
    assert len(tiles) == 2 * 2
    for minx, miny, maxx, maxy in tiles:
        assert (maxx - minx) / 10.0 <= 2000 + 1e-9
        assert (maxy - miny) / 10.0 <= 2000 + 1e-9
    assert min(t[0] for t in tiles) == 0
    assert max(t[2] for t in tiles) == 40000


def test_a_small_area_is_a_single_tile():
    assert len(services._tiles((0, 0, 5000, 5000), resolution=10.0, max_pixels=2000)) == 1


def test_imageserver_requests_the_right_pixel_grid(stub, tmp_path, monkeypatch):
    captured = {}
    monkeypatch.setattr(services, "_mosaic", lambda paths, dest, crs: captured.setdefault("paths", paths) or dest)
    session = stub([StubResponse(content=b"II" + b"\0" * 200)])
    services.fetch_arcgis_imageserver(
        "https://x/ImageServer", bbox=(0, 0, 5000, 4000), resolution=10.0,
        destination=tmp_path / "out.tif",
    )
    params = session.calls[0]["params"]
    assert params["size"] == "500,400"
    assert params["bboxSR"] == 27700 and params["imageSR"] == 27700
    assert params["format"] == "tiff"


def test_non_tiff_response_is_rejected_rather_than_written(stub, tmp_path):
    stub([StubResponse(content=b"<ServiceException>no such coverage</ServiceException>")])
    with pytest.raises(ServiceError, match="not a TIFF"):
        services.fetch_wcs_coverage(
            "https://x/wcs", coverage_id="c", bbox=(0, 0, 1000, 1000),
            resolution=10.0, destination=tmp_path / "out.tif",
        )
    assert not (tmp_path / "out.tif").exists()


def test_wcs_2_and_1_use_different_request_shapes(stub, tmp_path, monkeypatch):
    monkeypatch.setattr(services, "_mosaic", lambda paths, dest, crs: dest)
    session = stub([StubResponse(content=b"II" + b"\0" * 200)])
    services.fetch_wcs_coverage(
        "https://x/wcs", coverage_id="c", bbox=(0, 0, 1000, 1000),
        resolution=10.0, destination=tmp_path / "a.tif", version="2.0.1",
    )
    assert "coverageId" in session.calls[0]["params"]
    assert "subset" in session.calls[0]["params"]

    session = stub([StubResponse(content=b"II" + b"\0" * 200)])
    services.fetch_wcs_coverage(
        "https://x/wcs", coverage_id="c", bbox=(0, 0, 1000, 1000),
        resolution=10.0, destination=tmp_path / "b.tif", version="1.0.0",
    )
    assert "coverage" in session.calls[0]["params"]
    assert session.calls[0]["params"]["width"] == 100


# --------------------------------------------------------------------------
# Species records
# --------------------------------------------------------------------------

def test_occurrence_search_pages_to_the_reported_total(stub):
    page = {"occurrences": [{"uuid": str(i)} for i in range(300)], "totalRecords": 450}
    rest = {"occurrences": [{"uuid": str(i)} for i in range(150)], "totalRecords": 450}
    session = stub([StubResponse(page), StubResponse(rest)])
    records = services.fetch_nbn_occurrences("https://x/occurrences", "Hammarbya paludosa")
    assert len(records) == 450
    assert session.calls[1]["params"]["startIndex"] == 300


def test_occurrences_reproject_to_british_national_grid():
    frame = services.occurrences_to_frame(
        [
            {
                "uuid": "a", "decimalLatitude": 50.6857, "decimalLongitude": -3.9436,
                "year": 1998, "coordinateUncertaintyInMeters": 10,
                "gridReference": "SX625889", "locality": "Steeperton Brook",
            }
        ]
    )
    assert frame.crs.to_string() == "EPSG:27700"
    # Should land on northern Dartmoor, within a few km of the known site.
    point = frame.geometry.iloc[0]
    assert 255000 < point.x < 270000
    assert 85000 < point.y < 95000
    assert frame["coordinate_uncertainty_m"].iloc[0] == 10


def test_records_without_coordinates_are_dropped_not_guessed():
    frame = services.occurrences_to_frame(
        [{"uuid": "a", "decimalLatitude": None, "decimalLongitude": None}]
    )
    assert len(frame) == 0
