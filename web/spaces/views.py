# -*- coding: utf-8 -*-
import base64
import binascii
import hashlib
import hmac
import json
import re
import urllib
from datetime import timedelta
from urlparse import urlparse
from wsgiref.util import FileWrapper

from django.conf import settings
from django.core.cache import cache
from django.core.urlresolvers import reverse
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.http import Http404, HttpResponse, StreamingHttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404, redirect, render
from django.utils.dateparse import parse_datetime
from django.utils.decorators import method_decorator
from django.utils.timezone import now
from django.utils.translation import get_language, ugettext as _
from django.views.decorators.csrf import csrf_exempt
from django.views.generic import View

from premises.models import Contention
from spaces import anarlog, categorize, filetypes
from spaces.models import (Category, ChatMessage, Item, LogEntry,
                           PadRevision, Session, Space, TEXT_KINDS,
                           ITEM_KINDS, MAX_NAME_LENGTH, SOURCE_ANARLOG,
                           SOURCE_CHAT, SOURCE_UPLOAD, SUMMARY, TEXT, URL,
                           name_of, render_markdown)

MAX_SPACE_NAME = 120
MAX_TITLE = 200
MAX_CHAT_TEXT = 4000
MAX_CATEGORIES = 10
MAX_CATEGORY_NAME = 40
MAX_PAD_STATE = 4 * 1024 * 1024
MIN_PAD_SAVE_SECONDS = 5
MAX_HOOK_BODY = 8 * 1024 * 1024
MAX_HOOK_AGE = timedelta(days=1)
PAGE_SIZE = 100

LINK = re.compile(r"https?://[^\s<>\"']+", re.I)


def json_response(data, status=200):
    return HttpResponse(json.dumps(data), status=status,
                        content_type="application/json")


def error(message, status=400):
    return json_response({"error": unicode(message)}, status=status)


def client_ip(request):
    # nginx sets X-Real-IP; gunicorn only sees nginx in REMOTE_ADDR
    return (request.META.get("HTTP_X_REAL_IP") or
            request.META.get("REMOTE_ADDR") or "unknown")


def over_limit(request, name, limit, seconds=3600):
    """True when this address has used up its turns for this action."""
    key = "spaces:limit:%s:%s" % (name, client_ip(request))
    cache.add(key, 0, seconds)
    try:
        return cache.incr(key) > limit
    except ValueError:
        return False


def clean_filename(name):
    name = (name or u"").replace("\\", "/").rsplit("/", 1)[-1].strip()
    name = u"".join(c for c in name if c >= u" " and c != u"\x7f")
    return name[-255:] or u"file"


def valid_link(url):
    parts = urlparse(url)
    return parts.scheme in ("http", "https") and bool(parts.hostname)


def script_json(data):
    # escaped so the JSON can't close the <script> it is printed in
    return json.dumps(data).replace("<", "\\u003c")


class SpaceView(View):
    """Every view of a space: the token of the address is the only key."""

    def dispatch(self, request, *args, **kwargs):
        self.space = get_object_or_404(Space, token=kwargs.pop("token"))
        response = super(SpaceView, self).dispatch(request, *args, **kwargs)
        # the address is the key: it must not go to the sites people click
        response["Referrer-Policy"] = "no-referrer"
        response["X-Robots-Tag"] = "noindex, nofollow"
        return response

    def body(self):
        """The JSON body of the request, or {} when it is not a JSON object."""
        try:
            data = json.loads(self.request.body)
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def visitor_name(self, supplied):
        """The name a person gave in the room; kept on the guest profile."""
        user = self.request.user
        if isinstance(supplied, basestring) and supplied.strip():
            name = supplied.strip()[:MAX_NAME_LENGTH]
            if user.first_name != name:
                user.first_name = name
                user.save(update_fields=["first_name"])
        return name_of(user)

    def log(self, action, detail=u"", session=None, item=None, name=None):
        LogEntry.objects.create(
            space=self.space, session=session, item=item,
            actor=self.request.user,
            actor_name=name if name is not None else name_of(self.request.user),
            action=action, detail=detail[:500])

    def get_session(self, pk):
        return get_object_or_404(Session, space=self.space, pk=pk)

    def get_item(self, pk):
        return get_object_or_404(Item, space=self.space, pk=pk,
                                 removed_at__isnull=True)

    def session_of(self, value):
        """A session of this space from an id in a request, or None."""
        try:
            return self.space.sessions.get(pk=int(value))
        except (Session.DoesNotExist, TypeError, ValueError):
            return None

    def category_names(self):
        return list(self.space.categories.values_list("name", flat=True))

    def suggestions(self, title=u"", body=u"", url=u""):
        return json.dumps(categorize.suggest(
            self.category_names(), get_language(),
            title=title, body=body, url=url))

    def set_categories(self, item, names):
        """Returns False when the list is not valid."""
        if not isinstance(names, list) or len(names) > MAX_CATEGORIES:
            return False
        categories = []
        for name in names:
            if not isinstance(name, basestring):
                return False
            name = name.strip()[:MAX_CATEGORY_NAME]
            if not name:
                continue
            existing = self.space.categories.filter(name__iexact=name).first()
            categories.append(existing or Category.objects.get_or_create(
                space=self.space, name=name)[0])
        item.categories = categories
        return True


class SpaceCreateView(View):
    def get(self, request):
        return render(request, "spaces/create.html", {
            "claim": Contention.objects.filter(
                slug=request.GET.get("claim", "")).first()
        })

    def post(self, request):
        name = request.POST.get("name", "").strip()[:MAX_SPACE_NAME]
        claim = Contention.objects.filter(
            slug=request.POST.get("claim", "")).first()
        if not name:
            return render(request, "spaces/create.html", {
                "claim": claim, "error": _("The space needs a name.")
            }, status=400)
        if over_limit(request, "create", settings.SPACE_CREATE_PER_HOUR):
            return render(request, "spaces/create.html", {
                "claim": claim,
                "error": _("Too many new spaces from this address. "
                           "Try again later.")
            }, status=429)
        space = Space.objects.create(name=name, creator=request.user,
                                     contention=claim)
        LogEntry.objects.create(space=space, actor=request.user,
                                actor_name=name_of(request.user),
                                action="space_created", detail=name)
        return redirect(space)


class SpaceDetailView(SpaceView):
    def config(self):
        request, space = self.request, self.space
        token = space.token

        def url(name, *args):
            return reverse(name, args=(token,) + args)

        def per_session(name):
            return url(name, 0).replace("/0", "/{id}", 1)

        def per_item(name):
            return url(name, 0).replace("/0", "/{id}", 1)

        return {
            "room": space.room,
            "wsUrl": settings.REALTIME_WS_URL,
            "iceServers": settings.ICE_SERVERS,
            "csrfToken": get_token(request),
            "name": name_of(request.user),
            "maxFileBytes": settings.SPACE_MAX_FILE_BYTES,
            "kinds": [{"kind": kind, "label": unicode(label)}
                      for kind, label in ITEM_KINDS],
            "canManage": space.can_manage(request.user),
            "hookUrl": request.build_absolute_uri(
                reverse("space_anarlog_hook", args=[space.hook_key])),
            "urls": {
                "state": url("space_state"),
                "rotate": url("space_rotate"),
                "items": url("space_items"),
                "upload": url("space_item_upload"),
                "itemNew": url("space_item_new"),
                "item": per_item("space_item"),
                "itemRemove": per_item("space_item_remove"),
                "itemSession": per_item("space_item_session"),
                "chat": url("space_chat"),
                "chatPost": url("space_chat_post"),
                "sessionNew": url("space_session_new"),
                "sessionEnd": per_session("space_session_end"),
                "sessionExport": per_session("space_session_export"),
                "pad": per_session("space_pad"),
                "padRevisions": per_session("space_pad_revisions"),
                "takingNotes": per_session("space_taking_notes"),
                "anarlogImport": per_session("space_anarlog_import"),
                "anarlogSettings": url("space_anarlog_settings"),
                "log": url("space_log"),
            },
        }

    def get(self, request):
        return render(request, "spaces/space.html", {
            "space": self.space,
            "space_config": script_json(self.config()),
        })


class SpaceRotateView(SpaceView):
    """A new secret link. The old one stops working at once."""

    def post(self, request):
        if not self.space.can_manage(request.user):
            return error(_("Only who made the space can change its link."), 403)
        self.space.rotate_token()
        self.log("link_rotated")
        return json_response({"url": self.space.get_absolute_url()})


class SpaceStateView(SpaceView):
    def get(self, request):
        space = self.space
        current = space.open_session()
        return json_response({
            "name": space.name,
            "sessions": [session.serialize()
                         for session in space.sessions.all()[:PAGE_SIZE]],
            "current": current and current.pk,
            "categories": self.category_names(),
            "usedBytes": space.used_bytes(),
            "maxBytes": settings.SPACE_MAX_BYTES,
            "anarlogHook": bool(space.anarlog_secret),
        })


class SpaceLogView(SpaceView):
    def get(self, request):
        entries = self.space.log.select_related("session", "item")
        session = self.session_of(request.GET.get("session"))
        if session:
            entries = entries.filter(session=session)
        return render(request, "spaces/log.html", {
            "space": self.space,
            "session": session,
            "entries": entries[:500],
        })


class SessionCreateView(SpaceView):
    def post(self, request):
        data = self.body()
        current = self.space.open_session()
        if current:
            # one meeting at a time: someone else has just started it
            return json_response({"session": current.serialize()})
        title = data.get("title")
        if not isinstance(title, basestring) or not title.strip():
            title = now().strftime("%Y-%m-%d %H:%M")
        name = self.visitor_name(data.get("name"))
        session = Session.objects.create(space=self.space,
                                         title=title.strip()[:MAX_TITLE],
                                         started_by=request.user)
        self.log("session_started", session.title, session=session, name=name)
        return json_response({"session": session.serialize()})


class SessionEndView(SpaceView):
    def post(self, request, pk):
        session = self.get_session(pk)
        if session.ended_at is None:
            session.ended_at = now()
            session.save(update_fields=["ended_at"])
            self.log("session_ended", session.title, session=session)
        return json_response({"session": session.serialize()})


class SessionExportView(SpaceView):
    """A session as one Markdown file, to keep it outside KLAP too."""

    def get(self, request, pk):
        session = self.get_session(pk)
        lines = [u"# %s" % session.title, u"",
                 u"- %s: %s" % (_("space"), self.space.name),
                 u"- %s: %s" % (_("started"), session.started_at.isoformat())]
        if session.ended_at:
            lines.append(u"- %s: %s" % (_("ended"),
                                        session.ended_at.isoformat()))

        items = list(session.items.filter(removed_at__isnull=True)
                     .order_by("created_at", "id")
                     .prefetch_related("categories"))
        for item in items:
            if item.kind == SUMMARY:
                lines += [u"", u"## %s" % item.title, u"", item.body]

        pad = session.pad_revisions.first()
        if pad and pad.text.strip():
            lines += [u"", u"## %s" % _("Notes"), u"", pad.text]

        others = [item for item in items if item.kind != SUMMARY]
        if others:
            lines += [u"", u"## %s" % _("Documents"), u""]
            for item in others:
                where = u" <%s>" % item.url if item.url else (
                    u" (%s)" % item.filename if item.filename else u"")
                tags = u", ".join(item.category_names())
                lines.append(u"- %s%s%s" % (
                    item.title, where, u" [%s]" % tags if tags else u""))

        messages = session.messages.order_by("id")
        if messages:
            lines += [u"", u"## %s" % _("Chat"), u""]
            lines += [u"- %s %s: %s" % (m.created_at.strftime("%H:%M"),
                                        m.author_name, m.text)
                      for m in messages if m.text]

        response = HttpResponse(u"\n".join(lines) + u"\n",
                                content_type="text/markdown; charset=utf-8")
        response["Content-Disposition"] = (
            'attachment; filename="session-%d.md"' % session.pk)
        return response


class TakingNotesView(SpaceView):
    """Someone says that they record the meeting with a note taker."""

    def post(self, request, pk):
        session = self.get_session(pk)
        data = self.body()
        name = self.visitor_name(data.get("name"))
        self.log("notes_on" if data.get("on") else "notes_off",
                 session=session, name=name)
        return json_response({"ok": True})


class ItemListView(SpaceView):
    def get(self, request):
        items = (self.space.items.filter(removed_at__isnull=True)
                 .select_related("space").prefetch_related("categories"))
        if request.GET.get("kind"):
            items = items.filter(kind=request.GET["kind"])
        if request.GET.get("category"):
            items = items.filter(categories__name=request.GET["category"])
        session = self.session_of(request.GET.get("session"))
        if session:
            items = items.filter(session=session)
        query = request.GET.get("q", "").strip()
        if query:
            items = items.filter(Q(title__icontains=query) |
                                 Q(body__icontains=query) |
                                 Q(filename__icontains=query) |
                                 Q(url__icontains=query))
        return json_response({
            "items": [item.serialize() for item in items[:PAGE_SIZE * 2]]
        })


class ItemUploadView(SpaceView):
    """
    One file, from the library or from the chat. Multipart fields: file, and
    optional name, title, session, caption, pasted, chat ("1" also posts it
    in the chat).
    """

    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            return error(_("There is no file."))
        if upload.size > settings.SPACE_MAX_FILE_BYTES:
            return error(_("The file is too big."), 413)
        if over_limit(request, "upload", settings.SPACE_UPLOADS_PER_HOUR):
            return error(_("Too many files from this address. "
                           "Try again later."), 429)
        if self.space.used_bytes() + upload.size > settings.SPACE_MAX_BYTES:
            return error(_("This space is full. Removed files count until "
                           "an administrator deletes them."), 413)

        filename = clean_filename(upload.name)
        found = filetypes.sniff(upload, filename)
        if found is None:
            return error(_("KLAP does not accept this type of file."), 415)
        mime, extension = found

        digest = hashlib.sha256()
        for chunk in upload.chunks():
            digest.update(chunk)
        upload.seek(0)

        post = request.POST
        name = self.visitor_name(post.get("name"))
        from_chat = post.get("chat") == "1"
        session = self.session_of(post.get("session"))
        title = post.get("title", "").strip()[:255] or filename

        item = Item(space=self.space, session=session, author=request.user,
                    author_name=name, title=title, filename=filename,
                    kind=filetypes.kind_of(mime, filename,
                                           post.get("pasted") == "1"),
                    source=SOURCE_CHAT if from_chat else SOURCE_UPLOAD,
                    size=upload.size, sha256=digest.hexdigest(), mime=mime,
                    suggested=self.suggestions(title=title))
        item.file.save(filename, upload, save=False)
        item.save()
        item.snapshot(request.user, name)
        self.log("item_added", item.title, session=session, item=item,
                 name=name)

        data = {"item": item.serialize()}
        if from_chat:
            message = ChatMessage.objects.create(
                space=self.space, session=session, author=request.user,
                author_name=name,
                text=post.get("caption", "").strip()[:MAX_CHAT_TEXT])
            message.items.add(item)
            data["message"] = message.serialize()
        return json_response(data)


class ItemCreateView(SpaceView):
    """A link or a text, from a JSON body."""

    def post(self, request):
        data = self.body()
        name = self.visitor_name(data.get("name"))
        session = self.session_of(data.get("session"))
        title = data.get("title")
        title = title.strip()[:255] if isinstance(title, basestring) else u""
        url = data.get("url")

        if url:
            if not isinstance(url, basestring) or len(url) > 2000 or \
                    not valid_link(url.strip()):
                return error(_("This is not a link that starts with http."))
            url = url.strip()
            item = Item(space=self.space, kind=URL, url=url,
                        title=title or categorize.host_of(url),
                        suggested=self.suggestions(title=title, url=url))
        else:
            body = data.get("body")
            if not isinstance(body, basestring) or not body.strip():
                return error(_("The text is empty."))
            if len(body) > settings.SPACE_MAX_TEXT:
                return error(_("The text is too long."), 413)
            if not title:
                return error(_("The text needs a title."))
            item = Item(space=self.space, kind=TEXT, title=title, body=body,
                        suggested=self.suggestions(title=title, body=body))

        item.session = session
        item.author = request.user
        item.author_name = name
        item.save()
        item.snapshot(request.user, name)
        self.log("item_added", item.title, session=session, item=item,
                 name=name)
        return json_response({"item": item.serialize()})


class ItemDetailView(SpaceView):
    def get(self, request, pk):
        item = self.get_item(pk)
        return json_response({
            "item": item.serialize(full=True),
            "canRemove": item.can_remove(request.user),
            "history": [revision.serialize()
                        for revision in item.revisions.all()[:PAGE_SIZE]],
        })

    def post(self, request, pk):
        item = self.get_item(pk)
        data = self.body()
        name = self.visitor_name(data.get("name"))
        before = (item.title, item.body, sorted(item.category_names()))

        if isinstance(data.get("title"), basestring) and data["title"].strip():
            item.title = data["title"].strip()[:255]
        if item.kind in TEXT_KINDS and isinstance(data.get("body"), basestring):
            if len(data["body"]) > settings.SPACE_MAX_TEXT:
                return error(_("The text is too long."), 413)
            item.body = data["body"]
        if "categories" in data and \
                not self.set_categories(item, data["categories"]):
            return error(_("The categories are not valid."))

        if before != (item.title, item.body, sorted(item.category_names())):
            item.save(update_fields=["title", "body"])
            item.snapshot(request.user, name)
            self.log("item_edited", item.title, session=item.session,
                     item=item, name=name)
        return json_response({"item": item.serialize(full=True)})


class ItemRemoveView(SpaceView):
    def post(self, request, pk):
        item = self.get_item(pk)
        if not item.can_remove(request.user):
            return error(_("Only who added it or made the space can remove "
                           "it."), 403)
        item.removed_at = now()
        item.save(update_fields=["removed_at"])
        self.log("item_removed", item.title, session=item.session, item=item)
        return json_response({"ok": True})


class ItemSessionView(SpaceView):
    """Files a document in a session, so it is part of its history."""

    def post(self, request, pk):
        item = self.get_item(pk)
        session = self.session_of(self.body().get("session"))
        if session is None:
            return error(_("There is no such session."))
        item.session = session
        item.save(update_fields=["session"])
        self.log("item_filed", item.title, session=session, item=item)
        return json_response({"item": item.serialize()})


class ItemFileView(SpaceView):
    """
    The only way to a stored file. The browser must never run what a guest
    uploaded: only images and PDFs can be shown, and nothing can be sniffed
    into something else. A PDF gets no sandbox, because Chrome and Firefox
    do not open their viewer in a sandboxed document.
    """

    def get(self, request, pk):
        item = self.get_item(pk)
        if not item.file:
            raise Http404

        if settings.SPACE_FILES_ACCEL:
            response = HttpResponse(content_type=item.mime)
            response["X-Accel-Redirect"] = (
                settings.SPACE_FILES_ACCEL + item.file.name)
        else:
            response = StreamingHttpResponse(FileWrapper(item.file.file),
                                             content_type=item.mime)
            response["Content-Length"] = item.size

        inline = item.is_inline() and "download" not in request.GET
        response["Content-Disposition"] = "%s; filename*=UTF-8''%s" % (
            "inline" if inline else "attachment",
            urllib.quote(item.filename.encode("utf-8"), safe=""))
        response["X-Content-Type-Options"] = "nosniff"
        if item.mime != "application/pdf":
            response["Content-Security-Policy"] = (
                "sandbox; default-src 'none'; img-src 'self' data:; "
                "style-src 'unsafe-inline'")
        return response


class ChatListView(SpaceView):
    def get(self, request):
        messages = (self.space.messages
                    .prefetch_related("items__categories", "items__space"))
        get = request.GET
        if get.get("q"):
            messages = messages.filter(
                Q(text__icontains=get["q"]) |
                Q(items__title__icontains=get["q"])).distinct()
        if get.get("kind"):
            messages = messages.filter(items__kind=get["kind"]).distinct()
        if get.get("category"):
            messages = messages.filter(
                items__categories__name=get["category"]).distinct()
        if get.get("person"):
            messages = messages.filter(author_name=get["person"])
        if get.get("after", "").isdigit():
            messages = messages.filter(pk__gt=int(get["after"]))
            page = list(messages[:PAGE_SIZE])
        else:
            page = list(messages.order_by("-id")[:PAGE_SIZE])[::-1]
        return json_response({"messages": [m.serialize() for m in page]})


class ChatPostView(SpaceView):
    def post(self, request):
        data = self.body()
        text = data.get("text")
        if not isinstance(text, basestring) or not text.strip():
            return error(_("The message is empty."))
        if len(text) > MAX_CHAT_TEXT:
            return error(_("The message is too long."), 413)
        if over_limit(request, "chat", settings.SPACE_MESSAGES_PER_HOUR):
            return error(_("Too many messages. Wait a little."), 429)

        text = text.strip()
        name = self.visitor_name(data.get("name"))
        session = self.session_of(data.get("session"))
        message = ChatMessage.objects.create(
            space=self.space, session=session, author=request.user,
            author_name=name, text=text)

        # a link in a message also goes to the library; KLAP never opens it
        for url in set(url.rstrip(".,;:!?)") for url in LINK.findall(text)):
            if len(url) > 2000 or not valid_link(url):
                continue
            item = self.space.items.filter(url=url,
                                           removed_at__isnull=True).first()
            if item is None:
                item = Item.objects.create(
                    space=self.space, session=session, author=request.user,
                    author_name=name, kind=URL, source=SOURCE_CHAT, url=url,
                    title=categorize.host_of(url),
                    suggested=self.suggestions(url=url))
                item.snapshot(request.user, name)
                self.log("item_added", item.title, session=session, item=item,
                         name=name)
            message.items.add(item)
        return json_response({"message": message.serialize()})


class PadView(SpaceView):
    """
    The notes of a session. The relay keeps nothing, so one browser sends the
    merged state here from time to time. Only the browsers can merge it.
    """

    def get(self, request, pk):
        revision = self.get_session(pk).pad_revisions.first()
        return json_response({
            "state": base64.b64encode(bytes(revision.state)) if revision
            else None,
            "text": revision.text if revision else u"",
        })

    def post(self, request, pk):
        session = self.get_session(pk)
        text = request.POST.get("text", "")
        try:
            state = base64.b64decode(request.POST.get("state", ""))
        except (TypeError, binascii.Error):
            return error("invalid state")
        if not state:
            return error("invalid state")
        if len(state) > MAX_PAD_STATE or len(text) > settings.SPACE_MAX_TEXT:
            return error(_("The notes are too long."), 413)

        latest = session.pad_revisions.first()
        if latest is not None:
            recent = now() - latest.created_at < timedelta(
                seconds=MIN_PAD_SAVE_SECONDS)
            if latest.text == text:
                return json_response({"saved": False})
            if recent:
                return json_response({"saved": False, "soon": True})
        PadRevision.objects.create(session=session, text=text, state=state)
        return json_response({"saved": True})


class PadRevisionsView(SpaceView):
    def get(self, request, pk):
        revisions = (self.get_session(pk).pad_revisions
                     .defer("state", "text")[:500])
        return json_response({"revisions": [
            {"id": revision.pk, "created_at": revision.created_at.isoformat()}
            for revision in revisions]})


class PadRevisionView(SpaceView):
    def get(self, request, pk, revision):
        found = get_object_or_404(PadRevision, session=self.get_session(pk),
                                  pk=revision)
        return json_response({"text": found.text,
                              "created_at": found.created_at.isoformat()})


def file_meeting(space, session, meeting, name, actor=None):
    """
    Adds a meeting from anarlog to the space, or updates the one it already
    gave. Returns the item, or None when nothing is different.
    """
    external_id = meeting.get("external_id")
    item = None
    if external_id:
        item = space.items.filter(external_id=external_id).first()
    if item is not None:
        if item.title == meeting["title"] and item.body == meeting["body"]:
            return None
        item.title = meeting["title"][:255]
        item.body = meeting["body"]
        item.removed_at = None
        item.save(update_fields=["title", "body", "removed_at"])
        action = "summary_updated"
    else:
        item = Item.objects.create(
            space=space, session=session, author=actor, author_name=name,
            kind=SUMMARY, source=SOURCE_ANARLOG, external_id=external_id,
            title=meeting["title"][:255], body=meeting["body"],
            suggested=json.dumps(categorize.suggest(
                list(space.categories.values_list("name", flat=True)),
                get_language(), title=meeting["title"], body=meeting["body"])))
        action = "summary_imported"
    item.snapshot(actor, name)
    LogEntry.objects.create(space=space, session=item.session, item=item,
                            actor=actor, actor_name=name, action=action,
                            detail=item.title[:500])
    return item


class AnarlogImportView(SpaceView):
    """
    The Markdown export of anarlog, dropped or pasted in the session. With
    "preview" it only says what would be filed.
    """

    def post(self, request, pk):
        session = self.get_session(pk)
        data = self.body()
        markdown = data.get("markdown")
        if not isinstance(markdown, basestring) or not markdown.strip():
            return error(_("The text is empty."))
        if len(markdown) > settings.SPACE_MAX_TEXT:
            return error(_("The text is too long."), 413)

        meeting = anarlog.parse_export(
            markdown, include_transcript=data.get("transcript") is True)
        if data.get("preview"):
            return json_response({
                "title": meeting["title"],
                "html": render_markdown(meeting["body"]),
                "hasTranscript": meeting["has_transcript"],
            })

        name = self.visitor_name(data.get("name"))
        try:
            with transaction.atomic():
                item = file_meeting(self.space, session, meeting, name,
                                    actor=request.user)
        except IntegrityError:
            item = None  # the same meeting arrived at the same moment
        return json_response({"item": item and item.serialize()})


class AnarlogHookSettingsView(SpaceView):
    """Keeps the signing secret that anarlog shows once. It is never shown."""

    def post(self, request):
        data = self.body()
        secret = data.get("secret")
        if not isinstance(secret, basestring) or \
                not secret.strip().startswith("whsec_") or len(secret) > 255:
            return error(_("Copy the secret that starts with whsec_."))
        self.space.anarlog_secret = secret.strip()
        self.space.anarlog_transcripts = data.get("transcript") is True
        self.space.save(update_fields=["anarlog_secret",
                                       "anarlog_transcripts"])
        self.log("anarlog_connected")
        return json_response({"ok": True})


class AnarlogHookView(View):
    """
    Signed events of anarlog: HMAC-SHA256 of the raw body with the secret.
    Without a valid signature nothing is read.
    """

    @method_decorator(csrf_exempt)
    def dispatch(self, request, *args, **kwargs):
        return super(AnarlogHookView, self).dispatch(request, *args, **kwargs)

    def post(self, request, hook_key):
        space = get_object_or_404(Space, hook_key=hook_key)
        if not space.anarlog_secret:
            raise Http404
        length = str(request.META.get("CONTENT_LENGTH") or 0)
        if not length.isdigit() or int(length) > MAX_HOOK_BODY:
            return error("too large", 413)

        raw = request.body
        expected = "sha256=" + hmac.new(
            space.anarlog_secret.encode("utf-8"), raw,
            hashlib.sha256).hexdigest()
        received = request.META.get("HTTP_X_ANARLOG_SIGNATURE", "")
        if not hmac.compare_digest(expected, str(received)):
            return error("invalid signature", 401)

        try:
            event = json.loads(raw)
            created = parse_datetime(event["created_at"])
        except (ValueError, KeyError, TypeError):
            return error("invalid event")
        if created is None or created.tzinfo is None:
            return error("invalid event")
        if abs(now() - created) > MAX_HOOK_AGE:
            return error("stale event")

        if event.get("event") not in ("meeting.completed", "note.enhanced"):
            return json_response({"ok": True})  # webhook.test
        data = event.get("data")
        meeting = anarlog.render_event(
            data if isinstance(data, dict) else {},
            include_transcript=space.anarlog_transcripts)
        if meeting is not None:
            session = space.open_session() or space.sessions.first()
            try:
                with transaction.atomic():
                    file_meeting(space, session, meeting, u"anarlog")
            except IntegrityError:
                pass  # the same meeting arrived at the same moment
        return json_response({"ok": True})
