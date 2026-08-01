#!/usr/bin/env python3
import json
import shutil
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


def read_package() -> dict:
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))


def content_types_xml() -> str:
    return """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
"""


def manifest_xml(package: dict) -> str:
    name = escape(package["name"])
    version = escape(package["version"])
    publisher = escape(package["publisher"])
    display_name = escape(package["displayName"])
    description = escape(package["description"])

    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="{name}" Version="{version}" Publisher="{publisher}" />
    <DisplayName>{display_name}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Categories>Other</Categories>
    <Tags>codex,notifications,sound</Tags>
    <GalleryFlags>Public</GalleryFlags>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Readme" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
"""


def main() -> int:
    package = read_package()
    vsix = DIST / f"codex-beeper-{package['version']}.vsix"
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    with zipfile.ZipFile(vsix, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types_xml())
        archive.writestr("extension.vsixmanifest", manifest_xml(package))
        for filename in ["package.json", "extension.js", "README.md"]:
            archive.write(ROOT / filename, f"extension/{filename}")

    print(vsix)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
