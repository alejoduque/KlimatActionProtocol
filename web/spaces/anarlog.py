# -*- coding: utf-8 -*-
"""
Reads what anarlog (https://github.com/fastrepl/anarlog) gives: its Markdown
export and its webhook events. Anarlog runs on the computer of each person.
KLAP only receives the result.

The export is "# title", a list of metadata ("- ID: `...`", "- Date: ...",
"- Participants: ..."), then "## Notes", one section per summary,
"## Action items" and, the last one, "## Transcript".
"""
import re

DEFAULT_TITLE = u"Untitled meeting"

TITLE = re.compile(r"^#[ \t]+(.+?)[ \t]*$", re.M)
MEETING_ID = re.compile(r"^- ID:[ \t]*`([^`\n]+)`[ \t]*$", re.M)
TRANSCRIPT = re.compile(r"^##[ \t]+Transcript[ \t]*$", re.M | re.I)
METADATA_LINE = re.compile(r"^- (ID|Series|Folder):[ \t].*\n?", re.M)


def parse_export(markdown, include_transcript=False):
    """
    Returns a dict with title, body, external_id and has_transcript. The
    transcript has the exact words of everyone, so it stays out unless the
    person asks for it. It is always the last section of the export.
    """
    text = markdown.replace("\r\n", "\n").strip()
    found = TRANSCRIPT.search(text)
    has_transcript = found is not None
    if found and not include_transcript:
        text = text[:found.start()].rstrip()

    # the metadata list is all before the first section
    head, separator, rest = text.partition("\n## ")
    title = TITLE.search(head)
    meeting_id = MEETING_ID.search(head)
    return {
        "title": title.group(1) if title else DEFAULT_TITLE,
        "body": (METADATA_LINE.sub("", head) + separator + rest).strip(),
        "external_id": meeting_id.group(1) if meeting_id else None,
        "has_transcript": has_transcript,
    }


def text_of(value):
    return value.strip() if isinstance(value, basestring) else u""


def section(heading, body):
    return u"## %s\n\n%s" % (heading, body.strip())


def render_event(data, include_transcript=False):
    """
    The same layout as the export, from the data of a webhook event. The
    payload also has the email addresses of the participants: only their
    names are kept. Returns None when the meeting has no content yet.
    """
    meeting = data.get("meeting")
    if not isinstance(meeting, dict) or not text_of(meeting.get("id")):
        return None

    title = text_of(meeting.get("title")) or DEFAULT_TITLE
    sections = []

    note = meeting.get("note")
    if isinstance(note, dict) and text_of(note.get("markdown")):
        sections.append(section(u"Notes", note["markdown"]))

    for summary in meeting.get("summaries") or []:
        if isinstance(summary, dict) and text_of(summary.get("markdown")):
            sections.append(section(text_of(summary.get("title")) or u"Summary",
                                    summary["markdown"]))

    items = [item for item in meeting.get("action_items") or []
             if isinstance(item, dict) and text_of(item.get("text"))]
    if items:
        sections.append(section(u"Action items", u"\n".join(
            u"- [%s] %s" % ("x" if item.get("status") in ("done", "completed")
                            else " ", text_of(item["text"]))
            for item in items)))

    if not sections:
        return None

    head = [u"- Date: %s" % (text_of(meeting.get("started_at")) or
                             text_of(meeting.get("created_at")))]
    people = [text_of(person.get("display_name"))
              for person in meeting.get("participants") or []
              if isinstance(person, dict) and
              text_of(person.get("display_name"))]
    if people:
        head.append(u"- Participants: %s" % u", ".join(people))

    transcript = text_of(data.get("transcript_text"))
    if transcript and include_transcript:
        sections.append(section(u"Transcript", transcript))

    return {
        "title": title,
        "body": u"\n\n".join([u"# %s" % title, u"\n".join(head)] + sections),
        "external_id": meeting["id"].strip(),
    }
