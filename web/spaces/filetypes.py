# -*- coding: utf-8 -*-
"""
What an uploaded file really is, from its first bytes and not from its name
or from what the browser says. Anything that is not on this list is refused.
"""
import re
import zipfile

SIGNATURES = (
    ("\x89PNG\r\n\x1a\n", "image/png", "png"),
    ("\xff\xd8\xff", "image/jpeg", "jpg"),
    ("GIF87a", "image/gif", "gif"),
    ("GIF89a", "image/gif", "gif"),
    ("%PDF-", "application/pdf", "pdf"),
)

TEXT_TYPES = {
    "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "markdown": "text/markdown; charset=utf-8",
    "csv": "text/csv; charset=utf-8",
}

OOXML_TYPES = (
    ("word/", "docx",
     "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ("xl/", "xlsx",
     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ("ppt/", "pptx",
     "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
)

ODF_TYPES = {
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.presentation": "odp",
}

# only these are shown in the page; all the others are downloaded
INLINE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp",
                "application/pdf")

MARKUP = ("<!doctype", "<html", "<svg", "<?xml", "<script", "<body", "<head")

SCREENSHOT_NAME = re.compile(
    r"^(screen[ _-]?shot|screen[ _-]?capture|captura|pantallazo|"
    r"image[ _-]?paste|scr[ _-]\d)", re.I)


def extension_of(filename):
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def sniff_archive(fileobj):
    try:
        archive = zipfile.ZipFile(fileobj)
        names = archive.namelist()
        if "mimetype" in names:
            mime = archive.read("mimetype").strip()
            if mime in ODF_TYPES:
                return mime, ODF_TYPES[mime]
        if "[Content_Types].xml" in names:
            for prefix, extension, mime in OOXML_TYPES:
                if any(name.startswith(prefix) for name in names):
                    return mime, extension
    except (zipfile.BadZipfile, KeyError, IOError, RuntimeError):
        pass
    return None


def sniff_text(content, filename):
    extension = extension_of(filename)
    if extension not in TEXT_TYPES or "\x00" in content:
        return None
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    if text.lstrip()[:16].lower().startswith(MARKUP):
        return None
    return TEXT_TYPES[extension], extension


def sniff(fileobj, filename):
    """
    Returns (mime, extension) for an allowed file and None for any other.
    """
    fileobj.seek(0)
    content = fileobj.read()
    fileobj.seek(0)

    found = None
    for signature, mime, extension in SIGNATURES:
        if content.startswith(signature):
            found = mime, extension
            break
    if found is None and content[:4] == "RIFF" and content[8:12] == "WEBP":
        found = "image/webp", "webp"
    if found is None and content[:4] == "PK\x03\x04":
        found = sniff_archive(fileobj)
        fileobj.seek(0)
    if found is None:
        found = sniff_text(content, filename)
    return found


def kind_of(mime, filename, pasted=False):
    if mime == "application/pdf":
        return "pdf"
    if mime.startswith("image/") and (pasted or SCREENSHOT_NAME.match(filename)):
        return "screenshot"
    return "file"
