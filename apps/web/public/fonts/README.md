# Brand fonts

The Cosdon guidelines specify:

- **Intro Rust** — the logo font. Titles.
- **Aileron** — Extra Bold for subtitles, Regular for body text.

Neither is committed here, because neither ships with this repository and both
are licensed to Cosdon rather than to the code. Drop the web font files into
this directory and they are picked up automatically — `apps/web/src/styles.css`
already declares the faces:

```
IntroRust-Base.woff2
Aileron-Regular.woff2
Aileron-Bold.woff2
Aileron-Heavy.woff2
```

Until they are present the app falls back to the closest system faces, which is
why every rule in the stylesheet names a full stack rather than a single family.
The layout does not shift when the real fonts arrive; only the letterforms
change.

If you have the fonts in another format, convert them to woff2 first — it is
about 30% smaller than woff and is supported by every browser this app targets.
