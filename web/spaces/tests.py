# -*- coding: utf-8 -*-
import hashlib
import hmac
import json
import shutil
import tempfile
from datetime import timedelta

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.urlresolvers import reverse
from django.test import TestCase
from django.test.utils import override_settings
from django.utils.timezone import now

from profiles.models import Profile
from spaces import anarlog, categorize, filetypes
from spaces.models import (ChatMessage, Item, LogEntry, PadRevision, Session,
                           Space, render_markdown)

PNG = "\x89PNG\r\n\x1a\n" + "\x00" * 32
PDF = "%PDF-1.7\n" + "x" * 32


class SniffTest(TestCase):
    def check(self, content, name):
        upload = SimpleUploadedFile(name, content)
        return filetypes.sniff(upload, name)

    def test_real_types(self):
        self.assertEqual(self.check(PNG, "a.png")[0], "image/png")
        self.assertEqual(self.check(PDF, "a.pdf")[0], "application/pdf")
        self.assertEqual(self.check("# hola", "a.md")[1], "md")

    def test_the_name_does_not_decide(self):
        self.assertIsNone(self.check("<html><script>x</script>", "a.png"))
        self.assertIsNone(self.check("<svg onload=alert(1)>", "a.svg"))
        self.assertIsNone(self.check("<html>x", "a.txt"))
        self.assertIsNone(self.check("MZ\x00\x00", "a.txt"))
        self.assertIsNone(self.check("PK\x03\x04broken", "a.docx"))

    def test_screenshots(self):
        self.assertEqual(filetypes.kind_of("image/png", "photo.png"), "file")
        self.assertEqual(filetypes.kind_of("image/png", "x.png", True),
                         "screenshot")
        self.assertEqual(filetypes.kind_of("image/png", "Screenshot 1.png"),
                         "screenshot")
        self.assertEqual(filetypes.kind_of("application/pdf", "x.pdf"), "pdf")


class CategorizeTest(TestCase):
    def test_host_of_a_link(self):
        self.assertEqual(
            categorize.suggest([], "en", url="https://www.ipcc.ch/report"),
            ["ipcc.ch"])

    def test_stem_matches_existing_category(self):
        found = categorize.suggest([u"Glaciers", u"Finance"], "en",
                                   title=u"The glacier retreat")
        self.assertEqual(found, [u"Glaciers"])

    def test_repeated_words(self):
        found = categorize.suggest([], "es", body=u"agua agua agua "
                                   u"bosque bosque bosque bosque otra")
        self.assertEqual(found, [u"bosque"])


class MarkdownSafetyTest(TestCase):
    def test_no_html_or_script_links(self):
        html = render_markdown(u"<script>alert(1)</script>\n\n"
                               u"[x](javascript:alert(1))\n\n"
                               u"<img src=x onerror=alert(1)>")
        self.assertNotIn(u"<script", html)
        self.assertNotIn(u"javascript:", html)
        self.assertNotIn(u"<img", html)


EXPORT = u"""# Assembly

- ID: `meeting-1`
- Date: 2026-11-10T10:00:00Z
- Series: `s-1`
- Participants: Ana, Luz

## Notes

our note

## Summary

we decided

## Action items

- [ ] call the mayor

## Transcript

Ana: exact words
"""


class AnarlogParseTest(TestCase):
    def test_export(self):
        meeting = anarlog.parse_export(EXPORT)
        self.assertEqual(meeting["title"], u"Assembly")
        self.assertEqual(meeting["external_id"], "meeting-1")
        self.assertTrue(meeting["has_transcript"])
        self.assertIn(u"we decided", meeting["body"])
        self.assertIn(u"Participants: Ana", meeting["body"])
        self.assertNotIn(u"exact words", meeting["body"])
        self.assertNotIn(u"meeting-1", meeting["body"])

    def test_transcript_only_when_asked(self):
        meeting = anarlog.parse_export(EXPORT, include_transcript=True)
        self.assertIn(u"exact words", meeting["body"])

    def test_event_keeps_no_email(self):
        meeting = anarlog.render_event({
            "meeting": {
                "id": "m", "title": "T", "started_at": "2026",
                "summaries": [{"title": "S", "markdown": "done"}],
                "participants": [{"display_name": "Ana",
                                  "email": "ana@example.org"}],
                "action_items": [{"text": "go", "status": "done"}],
            },
            "transcript_text": "exact words",
        })
        self.assertIn(u"Participants: Ana", meeting["body"])
        self.assertIn(u"- [x] go", meeting["body"])
        self.assertNotIn(u"example.org", meeting["body"])
        self.assertNotIn(u"exact words", meeting["body"])

    def test_event_without_content(self):
        self.assertIsNone(anarlog.render_event({"meeting": {"id": "m"}}))
        self.assertIsNone(anarlog.render_event({}))


class SpaceTestCase(TestCase):
    def setUp(self):
        cache.clear()
        self.root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.root)
        self.override.enable()
        self.addCleanup(shutil.rmtree, self.root)
        self.addCleanup(self.override.disable)
        self.client.get("/spaces/")  # becomes a guest
        self.user = Profile.objects.latest("id")
        self.space = Space.objects.create(name="Assembly", creator=self.user)
        self.token = self.space.token

    def url(self, name, *args):
        return reverse(name, args=(self.space.token,) + args)

    def post(self, url, data=None):
        return self.client.post(url, json.dumps(data or {}),
                                content_type="application/json")

    def upload(self, content=PNG, filename="a.png", **fields):
        fields["file"] = SimpleUploadedFile(filename, content)
        return self.client.post(self.url("space_item_upload"), fields)

    def result(self, response):
        return json.loads(response.content)

    def as_someone_else(self):
        self.client.cookies.clear()
        self.client.get("/spaces/")


class AccessTest(SpaceTestCase):
    def test_wrong_token_is_not_found(self):
        response = self.client.get("/spaces/%s" % ("x" * 22))
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client.get(
            "/spaces/%s/state.json" % ("x" * 22)).status_code, 404)

    def test_page_does_not_leak_the_address(self):
        response = self.client.get(self.url("space_detail"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Referrer-Policy"], "no-referrer")
        self.assertIn("noindex", response["X-Robots-Tag"])

    def test_rotation_ends_the_old_link(self):
        old = self.url("space_detail")
        response = self.post(self.url("space_rotate"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get(old).status_code, 404)
        self.assertEqual(
            self.client.get(self.result(response)["url"]).status_code, 200)

    def test_only_the_creator_rotates(self):
        self.as_someone_else()
        self.assertEqual(self.post(self.url("space_rotate")).status_code, 403)

    def test_claims_do_not_take_the_address(self):
        self.assertEqual(self.client.get("/spaces").status_code, 302)
        self.assertEqual(self.client.get("/spaces/").status_code, 200)

    def test_create(self):
        response = self.client.post("/spaces/", {"name": "Bosque"})
        self.assertEqual(response.status_code, 302)
        space = Space.objects.get(name="Bosque")
        self.assertEqual(len(space.token), 22)
        self.assertTrue(LogEntry.objects.filter(
            space=space, action="space_created").exists())

    @override_settings(SPACE_CREATE_PER_HOUR=1)
    def test_create_limit(self):
        self.client.post("/spaces/", {"name": "one"})
        self.assertEqual(
            self.client.post("/spaces/", {"name": "two"}).status_code, 429)


class FileTest(SpaceTestCase):
    def test_upload_and_serve_image(self):
        item = self.result(self.upload())["item"]
        self.assertEqual(item["kind"], "file")
        response = self.client.get(item["file"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")
        self.assertTrue(response["Content-Disposition"].startswith("inline"))
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")
        self.assertIn("sandbox", response["Content-Security-Policy"])
        self.assertEqual("".join(response.streaming_content), PNG)

    def test_text_is_never_inline(self):
        item = self.result(self.upload("# hola", u"ñandú.md"))["item"]
        response = self.client.get(item["file"])
        disposition = response["Content-Disposition"]
        self.assertTrue(disposition.startswith("attachment"))
        self.assertIn("UTF-8''%C3%B1and%C3%BA.md", disposition)
        self.assertIn("sandbox", response["Content-Security-Policy"])

    def test_pdf_can_open_in_the_browser_viewer(self):
        item = self.result(self.upload(PDF, "a.pdf"))["item"]
        self.assertEqual(item["kind"], "pdf")
        response = self.client.get(item["file"])
        self.assertTrue(response["Content-Disposition"].startswith("inline"))
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")
        self.assertFalse(response.has_header("Content-Security-Policy"))

    def test_html_named_png_is_refused(self):
        response = self.upload("<html><script>x</script>", "a.png")
        self.assertEqual(response.status_code, 415)
        self.assertEqual(Item.objects.count(), 0)

    def test_stored_name_is_not_the_given_name(self):
        item = self.result(self.upload(PNG, "../../evil.png"))["item"]
        stored = Item.objects.get(pk=item["id"])
        self.assertEqual(stored.filename, "evil.png")
        self.assertNotIn("evil", stored.file.name)

    @override_settings(SPACE_FILES_ACCEL="/_space_files/")
    def test_nginx_serves_in_production(self):
        item = self.result(self.upload())["item"]
        response = self.client.get(item["file"])
        self.assertTrue(response["X-Accel-Redirect"]
                        .startswith("/_space_files/spaces/"))
        self.assertEqual(response.content, "")

    @override_settings(SPACE_MAX_FILE_BYTES=10)
    def test_file_size_limit(self):
        self.assertEqual(self.upload().status_code, 413)

    @override_settings(SPACE_MAX_BYTES=50)
    def test_space_quota_counts_removed_files(self):
        item = self.result(self.upload())["item"]
        self.post(self.url("space_item_remove", item["id"]))
        self.assertEqual(self.upload().status_code, 413)

    @override_settings(SPACE_UPLOADS_PER_HOUR=1)
    def test_upload_limit(self):
        self.upload()
        self.assertEqual(self.upload().status_code, 429)

    def test_file_of_another_space(self):
        item = self.result(self.upload())["item"]
        other = Space.objects.create(name="other")
        self.assertEqual(self.client.get(
            reverse("space_file", args=[other.token, item["id"]])
        ).status_code, 404)

    def test_removed_file_is_gone(self):
        item = self.result(self.upload())["item"]
        self.post(self.url("space_item_remove", item["id"]))
        self.assertEqual(self.client.get(item["file"]).status_code, 404)

    def test_only_author_or_creator_removes(self):
        item = self.result(self.upload())["item"]
        self.as_someone_else()
        self.assertEqual(self.post(
            self.url("space_item_remove", item["id"])).status_code, 403)


class LibraryTest(SpaceTestCase):
    def new_text(self, title=u"Plan", body=u"text"):
        return self.result(self.post(self.url("space_item_new"), {
            "title": title, "body": body}))["item"]

    def test_only_http_links(self):
        for url in ("javascript:alert(1)", "ftp://x.org/", "data:text/html,x"):
            response = self.post(self.url("space_item_new"), {"url": url})
            self.assertEqual(response.status_code, 400)
        item = self.result(self.post(self.url("space_item_new"), {
            "url": "https://www.ipcc.ch/a"}))["item"]
        self.assertEqual(item["title"], "ipcc.ch")
        self.assertEqual(item["suggested"], ["ipcc.ch"])

    def test_history_of_edits(self):
        item = self.new_text()
        url = self.url("space_item", item["id"])
        self.post(url, {"body": u"second", "categories": [u"agua", u"Agua "]})
        self.post(url, {"body": u"second", "categories": [u"agua"]})  # same
        data = self.result(self.client.get(url))
        self.assertEqual(data["item"]["categories"], [u"agua"])
        self.assertEqual([r["body"] for r in data["history"]],
                         [u"second", u"text"])
        self.assertEqual(self.space.categories.count(), 1)

    def test_filters(self):
        self.new_text(title=u"uno")
        two = self.new_text(title=u"dos")
        self.post(self.url("space_item", two["id"]), {"categories": [u"agua"]})
        url = self.url("space_items")
        self.assertEqual(len(self.result(self.client.get(
            url, {"category": u"agua"}))["items"]), 1)
        self.assertEqual(len(self.result(self.client.get(
            url, {"q": u"uno"}))["items"]), 1)
        self.assertEqual(len(self.result(self.client.get(
            url, {"kind": "text"}))["items"]), 2)

    def test_log_page_is_escaped(self):
        self.new_text(title=u"<script>alert(1)</script>")
        response = self.client.get(self.url("space_log"))
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("<script>alert(1)", response.content)


class SessionTest(SpaceTestCase):
    def start(self, title=u"Monday"):
        return self.result(self.post(self.url("space_session_new"), {
            "title": title}))["session"]

    def test_one_open_session(self):
        one, two = self.start(), self.start(u"other")
        self.assertEqual(one["id"], two["id"])
        self.post(self.url("space_session_end", one["id"]))
        self.assertNotEqual(self.start()["id"], one["id"])

    def test_export(self):
        session = self.start()
        self.post(self.url("space_chat_post"),
                  {"text": u"hola", "session": session["id"]})
        PadRevision.objects.create(session_id=session["id"], text=u"our notes",
                                   state=b"x")
        response = self.client.get(self.url("space_session_export",
                                            session["id"]))
        self.assertIn("attachment", response["Content-Disposition"])
        text = response.content.decode("utf-8")
        self.assertIn(u"# Monday", text)
        self.assertIn(u"our notes", text)
        self.assertIn(u"hola", text)

    def test_session_of_another_space(self):
        session = self.start()
        other = Space.objects.create(name="other")
        self.assertEqual(self.client.get(reverse(
            "space_session_export", args=[other.token, session["id"]])
        ).status_code, 404)

    def test_taking_notes_is_in_the_log(self):
        session = self.start()
        self.post(self.url("space_taking_notes", session["id"]),
                  {"on": True, "name": "Ana"})
        entry = LogEntry.objects.filter(action="notes_on").get()
        self.assertEqual(entry.actor_name, "Ana")


class ChatTest(SpaceTestCase):
    def say(self, text, **extra):
        extra["text"] = text
        return self.post(self.url("space_chat_post"), extra)

    def messages(self, **query):
        return self.result(self.client.get(self.url("space_chat"),
                                           query))["messages"]

    def test_after(self):
        first = self.result(self.say(u"uno"))["message"]
        self.say(u"dos")
        self.assertEqual([m["text"] for m in self.messages(after=first["id"])],
                         [u"dos"])

    def test_file_in_chat(self):
        data = self.result(self.upload(chat="1", caption=u"mira", pasted="1"))
        self.assertEqual(data["message"]["text"], u"mira")
        self.assertEqual(data["message"]["items"][0]["kind"], "screenshot")
        self.assertEqual(data["item"]["source"], "chat")

    def test_links_go_to_the_library_once(self):
        self.say(u"see https://ipcc.ch/a, and javascript:alert(1)")
        self.say(u"again https://ipcc.ch/a")
        self.assertEqual(self.space.items.filter(kind="url").count(), 1)
        self.assertEqual(self.messages()[1]["items"][0]["url"],
                         "https://ipcc.ch/a")

    def test_filter_by_kind_and_person(self):
        self.say(u"plain", name="Ana")
        self.upload(chat="1", name="Luz")
        self.assertEqual(len(self.messages(kind="file")), 1)
        self.assertEqual([m["author"] for m in self.messages(person="Luz")],
                         ["Luz"])

    def test_removed_item_leaves_the_message(self):
        data = self.result(self.upload(chat="1"))
        self.post(self.url("space_item_remove", data["item"]["id"]))
        self.assertEqual(self.messages()[0]["items"], [])

    def test_empty_and_long(self):
        self.assertEqual(self.say(u"  ").status_code, 400)
        self.assertEqual(self.say(u"x" * 4001).status_code, 413)

    def test_guest_name_is_kept(self):
        self.say(u"hola", name=u"Ana")
        self.assertEqual(ChatMessage.objects.get().author_name, u"Ana")
        self.assertEqual(Profile.objects.get(pk=self.user.pk).first_name,
                         u"Ana")


class PadTest(SpaceTestCase):
    def setUp(self):
        super(PadTest, self).setUp()
        self.session = Session.objects.create(space=self.space, title="s")

    def save(self, text, state="AQID"):
        return self.result(self.client.post(
            self.url("space_pad", self.session.pk),
            {"text": text, "state": state}))

    def test_round_trip(self):
        self.assertTrue(self.save(u"notas")["saved"])
        data = self.result(self.client.get(
            self.url("space_pad", self.session.pk)))
        self.assertEqual(data["text"], u"notas")
        self.assertEqual(data["state"], "AQID")

    def test_same_text_or_too_soon_adds_nothing(self):
        self.save(u"one")
        self.assertFalse(self.save(u"one")["saved"])
        self.assertFalse(self.save(u"two")["saved"])
        self.assertEqual(self.session.pad_revisions.count(), 1)

    def test_revisions_only_grow(self):
        self.save(u"one")
        PadRevision.objects.update(created_at=now() - timedelta(minutes=1))
        self.save(u"two")
        listing = self.result(self.client.get(
            self.url("space_pad_revisions", self.session.pk)))["revisions"]
        self.assertEqual(len(listing), 2)
        old = self.result(self.client.get(self.url(
            "space_pad_revision", self.session.pk, listing[1]["id"])))
        self.assertEqual(old["text"], u"one")

    def test_bad_state(self):
        response = self.client.post(self.url("space_pad", self.session.pk),
                                    {"text": u"x", "state": ""})
        self.assertEqual(response.status_code, 400)


class AnarlogImportTest(SpaceTestCase):
    def setUp(self):
        super(AnarlogImportTest, self).setUp()
        self.session = Session.objects.create(space=self.space, title="s")
        self.import_url = self.url("space_anarlog_import", self.session.pk)

    def test_preview_saves_nothing(self):
        data = self.result(self.post(self.import_url, {
            "markdown": EXPORT, "preview": True}))
        self.assertEqual(data["title"], u"Assembly")
        self.assertTrue(data["hasTranscript"])
        self.assertNotIn(u"exact words", data["html"])
        self.assertEqual(Item.objects.count(), 0)

    def test_transcript_out_by_default(self):
        self.post(self.import_url, {"markdown": EXPORT})
        item = Item.objects.get()
        self.assertEqual((item.kind, item.source, item.session_id),
                         ("summary", "anarlog", self.session.pk))
        self.assertNotIn(u"exact words", item.body)

    def test_same_meeting_updates_with_history(self):
        self.post(self.import_url, {"markdown": EXPORT})
        self.post(self.import_url, {"markdown": EXPORT})  # nothing new
        self.post(self.import_url,
                  {"markdown": EXPORT.replace(u"we decided", u"we changed")})
        item = Item.objects.get()
        self.assertIn(u"we changed", item.body)
        self.assertEqual(item.revisions.count(), 2)


class AnarlogHookTest(SpaceTestCase):
    SECRET = "whsec_abc"

    def setUp(self):
        super(AnarlogHookTest, self).setUp()
        self.space.anarlog_secret = self.SECRET
        self.space.save()
        self.session = Session.objects.create(space=self.space, title="s")
        self.hook = reverse("space_anarlog_hook", args=[self.space.hook_key])

    def event(self, kind="note.enhanced", created=None, summary=u"decided"):
        return json.dumps({
            "id": "evt_1", "event": kind,
            "created_at": created or now().isoformat(),
            "data": {"meeting": {
                "id": "m1", "title": "Call",
                "summaries": [{"title": "S", "markdown": summary}]},
                "transcript_text": "exact words"},
        })

    def deliver(self, body, secret=SECRET):
        signature = "sha256=" + hmac.new(secret, body,
                                         hashlib.sha256).hexdigest()
        self.client.cookies.clear()
        return self.client.post(self.hook, body,
                                content_type="application/json",
                                HTTP_X_ANARLOG_SIGNATURE=signature)

    def test_files_in_open_session(self):
        self.assertEqual(self.deliver(self.event()).status_code, 200)
        item = Item.objects.get()
        self.assertEqual(item.session_id, self.session.pk)
        self.assertNotIn(u"exact words", item.body)

    def test_bad_signature(self):
        response = self.deliver(self.event(), secret="whsec_wrong")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(Item.objects.count(), 0)

    def test_no_signature(self):
        response = self.client.post(self.hook, self.event(),
                                    content_type="application/json")
        self.assertEqual(response.status_code, 401)

    def test_retry_changes_nothing(self):
        body = self.event()
        self.deliver(body)
        self.deliver(body)
        self.assertEqual(Item.objects.get().revisions.count(), 1)

    def test_later_summary_updates_the_item(self):
        self.deliver(self.event())
        self.deliver(self.event(summary=u"better"))
        item = Item.objects.get()
        self.assertIn(u"better", item.body)
        self.assertEqual(item.revisions.count(), 2)

    def test_stale_event(self):
        old = (now() - timedelta(days=3)).isoformat()
        self.assertEqual(self.deliver(self.event(created=old)).status_code, 400)

    def test_test_event_files_nothing(self):
        self.assertEqual(
            self.deliver(self.event(kind="webhook.test")).status_code, 200)
        self.assertEqual(Item.objects.count(), 0)

    def test_makes_no_guest_profile(self):
        before = Profile.objects.count()
        self.deliver(self.event())
        self.assertEqual(Profile.objects.count(), before)

    def test_no_secret_no_hook(self):
        self.space.anarlog_secret = ""
        self.space.save()
        self.assertEqual(self.deliver(self.event()).status_code, 404)

    def test_settings_never_show_the_secret(self):
        url = self.url("space_anarlog_settings")
        self.assertEqual(self.post(url, {"secret": "nope"}).status_code, 400)
        self.post(url, {"secret": "whsec_new"})
        response = self.client.get(self.url("space_detail"))
        self.assertNotIn("whsec_new", response.content)
        state = self.client.get(self.url("space_state"))
        self.assertNotIn("whsec_new", state.content)
        self.assertTrue(self.result(state)["anarlogHook"])
