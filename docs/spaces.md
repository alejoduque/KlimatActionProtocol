# Spaces

A space is a group behind one secret link: chat, shared files, notes that
everyone writes together, voice and video, and the history of each session.
There are no accounts. Whoever has the link is in the group. Make one at
`/spaces/`, or with "open a space for this claim" on a claim page.

## What is in a space

- **Sessions.** One meeting at a time. Chat, files and notes go to the open
  session. "export .md" gives a whole session as one file, and "history" is
  the log of what happened.
- **Chat.** Write, drop files, paste a screenshot anywhere on the page, or use
  "+ files". Links in a message also go to the library. KLAP never opens them.
- **Library.** Files, screenshots, PDFs, links, texts and meeting summaries, by
  category and by session. Texts and summaries can be edited, and each edit
  stays in their history, like a wiki.
- **Categories** belong to the space. KLAP suggests some (dashed, "+ word"): the
  host of a link, categories that share a word with the item, and words that a
  text repeats. There is no AI on the server, and people decide. PDF contents
  are not read.
- **Notes.** One text per session, edited by all at once. "older versions" shows
  what was saved, and can bring a version back as a new edit.
- **Reading together.** Open a document and select "show to everyone". Pictures
  and PDFs show in the page, other types are downloaded. Page-by-page following
  of a PDF does not exist yet.

## Meeting summaries with anarlog

[Anarlog](https://github.com/fastrepl/anarlog) is a note taker that each person
installs on their own computer. No part of it runs on the KLAP server, and KLAP
cannot start it or see it. The panel "meeting summaries with anarlog" guides
people through it:

1. Install it, and check in a test call that it hears the other people.
2. Ask everyone, then press "I'm taking notes". All people in the space see
   this, also those who arrive later, and it stays in the history. It is a
   statement by that person: KLAP cannot check it.
3. Export the meeting as Markdown and drop or paste it in the panel:

   ```sh
   anarlog meetings export MEETING_ID --format markdown --output meeting.md
   ```

Transcripts have the exact words of everyone, so they stay out unless the
person selects the box. Exporting the same meeting again updates its summary,
with history.

**Automatically, with a webhook.** In anarlog: Settings, Developers, Webhooks.
Add the address from the panel and paste anarlog's secret (`whsec_…`) in the
panel. The address must be `https://`. Events only arrive while anarlog is open;
events from when it is closed are lost. KLAP checks the signature of each
event, and keeps participants' names but not their email addresses.

## How it is built

```
browser ── HTTPS ──────────► Django        spaces, chat, files, notes, history
   ├─── WebSocket /_rooms ─► klap-realtime "look again", notes edits, signalling
   └─── WebRTC (mesh) ─────► browsers      voice, video, ascii

anarlog (on a computer) ── HTTPS, signed ─► Django (optional)
```

- `web/spaces/` is the Django app. `static/js/assembly/space.js` is the page.
- The relay is the one of the live map (`realtime/`) and it did not change. The
  room name has the secret token, so a new link is also a new room.
- `static/js/assembly/pad.js` merges the notes in the browsers with
  [Yjs](https://github.com/yjs/yjs) (`static/js/lib/`; the build command is at
  the top of that file). The server cannot merge: one browser sends it the
  merged state after 30 seconds without edits.

## Install on the server

A new install with `deploy-wizard.sh` does this. On a server from before
spaces, after `git pull`, `migrate` and `collectstatic`, run once:

```sh
sudo bash web/spaces/install.sh
```

The files are in `space_files/` in the checkout, or in `MEDIA_ROOT` if you
change it. **Add that directory to your backups**, and watch the disk. By hand,
nginx needs this, and `SPACE_FILES_ACCEL = '/_space_files/'` in
`settings_local.py`:

```nginx
location /_space_files/ {
    internal;
    alias /home/klap/app/space_files/;
}
```

## Limits and responsibilities

Settings, with their defaults: `SPACE_MAX_FILE_BYTES` (20 MB; also change
`client_max_body_size` in nginx), `SPACE_MAX_BYTES` (200 MB per space),
`SPACE_MAX_TEXT`, `SPACE_CREATE_PER_HOUR`, `SPACE_UPLOADS_PER_HOUR`,
`SPACE_MESSAGES_PER_HOUR`.

- **Calls between networks need a TURN server.** See "Before a workshop" in
  [live.md](live.md). Chat, files and notes work without one.
- **A link that leaks opens the space** until someone makes a new one. Only the
  person who made the space, or staff, can do that. A guest who loses their
  browser cookie loses that power, so ask staff.
- **Guests can upload to your server.** Accepted types: PNG, JPEG, GIF, WebP,
  PDF, text, Markdown, CSV, OpenDocument and Office files, checked by their
  content. To delete a stored file for good: admin, Spaces, Items, "Delete the
  stored files of these items". A removed file stays on the disk, and counts
  in the quota, until then.
