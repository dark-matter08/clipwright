# Bundled fonts

`install.sh` fetches **DejaVu Sans** (regular + bold) from the upstream DejaVu
repository into this directory. DejaVu is licensed under the
[DejaVu Fonts License](https://dejavu-fonts.github.io/License.html) (a permissive
Bitstream Vera derivative — MIT-compatible for redistribution).

We do not commit the `.ttf` files — they're `.gitignore`d. Users fetch them
locally via `install.sh`. If they're missing at runtime, `clipwright.fonts.resolve`
falls back to system fonts (macOS Helvetica, Linux DejaVu, etc.).

To use your own font, set `font_path` in your caption/outro config JSON.
