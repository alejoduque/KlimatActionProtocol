# -*- coding:utf-8 -*-

import json
import re
from datetime import timedelta
from django.conf import settings
from django.core.serializers.json import DjangoJSONEncoder
from markdown2 import markdown

from django.contrib import messages
from django.core.urlresolvers import reverse
from django.utils import timezone
from django.db.models import Max, Sum
from django.utils.timezone import now
from django.http import HttpResponse, Http404
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404, redirect
from django.template.loader import render_to_string
from django.views.generic import DetailView, TemplateView, CreateView, View, RedirectView
from django.views.generic.edit import UpdateView
from django.utils.translation import get_language
from django.db.models import Count
from django.shortcuts import render

from blog.models import Post
from premises.constants import MAX_PREMISE_CONTENT_LENGTH
from premises.models import (Contention, Premise, Report, PREMISE_TYPES,
                             PREMISE_CLASSES, PREMISE_HELP, SEMANTIC,
                             FALLACY_TYPES)
from premises.forms import (ArgumentCreationForm, PremiseCreationForm,
                            PremiseEditForm, ReportForm)
from premises.signals import (added_premise_for_premise,
                              added_premise_for_contention,
                              reported_as_fallacy,
                              supported_a_premise)
from premises.templatetags.premise_tags import check_content_deletion
from premises.mixins import PaginationMixin, NextURLMixin
from newsfeed.models import Entry
from profiles.mixins import LoginRequiredMixin
from profiles.models import Profile
from nouns.models import Channel

from i18n.utils import normalize_language_code


def get_ip_address(request):
    return request.META.get('REMOTE_ADDR')


class ContentionDetailView(DetailView):
    queryset = (Contention.objects
                .select_related('user')
                .prefetch_related('premises'))
    context_object_name = 'contention'

    def get_template_names(self):
        view = self.request.GET.get("view")
        name = settings.DEFAULT_PREMISE_VIEW + "_view"
        if view in ["list", "tree"]:
            name = view + "_view"

        return ["premises/%s.html" % name]

    def get_parent(self):
        premise_id = self.kwargs.get("premise_id")
        if premise_id:
            return get_object_or_404(Premise, id=premise_id)

    def get_premises(self):
        contention = self.get_parent() or self.get_object()
        return contention.published_children()

    def get_context_data(self, **kwargs):
        contention = self.get_object()
        edit_mode = (
            self.request.user.is_superuser or
            self.request.user.is_staff or
            contention.user == self.request.user)

        parent = self.get_parent()
        serialized = contention.serialize(self.request.user)
        description = contention.title

        if parent:
            description = parent.text
        elif serialized['premises']:
            description = serialized['premises'][0]['text']

        return super(ContentionDetailView, self).get_context_data(
            premises=self.get_premises(),
            parent_premise=parent,
            description=description,
            path=contention.get_absolute_url(),
            edit_mode=edit_mode,
            serialized=serialized,
            live_config=self.get_live_config(contention),
            **kwargs)

    def get_live_config(self, contention):
        """
        Settings for the live map (static/js/assembly/live.js): everyone on
        the claim page sees what each person is typing as they type it, and
        adds reasons in place. Voice, video and ascii video go peer to peer;
        the realtime relay (realtime/) only forwards messages.
        """
        slug = contention.slug
        config = {
            "room": "klap:%s" % slug,
            "wsUrl": settings.REALTIME_WS_URL,
            "iceServers": settings.ICE_SERVERS,
            "maxLength": MAX_PREMISE_CONTENT_LENGTH,
            "treeUrl": "%s?partial=tree" % contention.get_absolute_url(),
            "dataUrl": reverse("contention_live_json", args=[slug]),
            "branchUrl": reverse("contention_branch", args=[slug]),
            "tbtUrl": reverse("premise_tbt", args=[slug, 0])
                .replace("/0/", "/{id}/"),
            "reportUrl": reverse("report_premise", args=[slug, 0])
                .replace("/0/", "/{id}/"),
            "textUrl": reverse("premise_text", args=[slug, 0])
                .replace("/0/", "/{id}/"),
            "searchUrl": reverse("contentions_search"),
            "csrfToken": get_token(self.request),
            "instruments": [{"type": premise_type,
                             "label": unicode(label),
                             "class": PREMISE_CLASSES[premise_type],
                             "help": unicode(PREMISE_HELP[premise_type])}
                            for premise_type, label in PREMISE_TYPES],
            "semanticType": SEMANTIC,
            "fallacies": [{"type": fallacy_type, "label": unicode(label)}
                          for fallacy_type, label in FALLACY_TYPES],
        }
        # escaped so the JSON can't close the <script> it is printed in
        return json.dumps(config).replace("<", "\\u003c")

    def get(self, request, *args, **kwargs):
        self.object = self.get_object()

        if not getattr(settings, 'PREVENT_LANGUAGE_REDIRECTION', False):
            host = request.META['HTTP_HOST']

            if not host.startswith(settings.AVAILABLE_LANGUAGES):
                return redirect(self.object.get_full_url(), permanent=True)

            if not normalize_language_code(get_language()) == self.object.language:
                return redirect(self.object.get_full_url(), permanent=True)

        partial = request.GET.get('partial')
        level = request.GET.get('level')

        if partial == "tree":
            # the whole map, for live.js to refresh in place
            return render(request, 'premises/tree.html', {
                'premises': self.object.serialize(self.request.user)['premises'],
                'serialized': {'slug': self.object.slug},
                'level': 1,
                'eager': True  # all levels at once: one request per refresh
            })

        if partial:
            contention = self.object

            try:
                serialized = contention.partial_serialize(int(partial), self.request.user)
            except (StopIteration, ValueError):
                raise Http404

            return render(request, 'premises/tree.html', {
                'premises': serialized['premises'],
                'serialized': serialized,
                'level': int(level)
            })

        return super(ContentionDetailView, self).get(request, *args, **kwargs)


class ContentionJsonView(DetailView):
    model = Contention

    def render_to_response(self, context, **response_kwargs):
        contention = self.get_object(self.get_queryset())
        return HttpResponse(json.dumps({
            "nodes": self.build_tree(contention, self.request.user),
        }), content_type="application/json")

    def build_tree(self, contention, user):
        return {
            "name": contention.title,
            "parent": None,
            "pk": contention.pk,
            "owner": contention.owner,
            "sources": contention.sources,
            "is_singular": self.is_singular(contention),
            "children": self.get_premises(contention, user)
        }

    def get_premises(self, contention, user, parent=None):
        children = [{
            "pk": premise.pk,
            "name": premise.text,
            "parent": parent.text if parent else None,
            "reportable_by_authenticated_user": self.user_can_report(
                premise, user),
            "report_count": premise.reports.count(),
            "user": {
                "id": premise.user.id,
                "username": premise.user.username,
                "absolute_url": reverse("auth_profile",
                                        args=[premise.user.username])
            },
            "sources": premise.sources,
            "premise_type": premise.premise_class(),
            "children": (self.get_premises(contention, user, parent=premise)
                         if premise.published_children().exists() else [])
        } for premise in contention.published_premises(parent)]
        return children

    def user_can_report(self, premise, user):
        if user.is_authenticated() and user != premise.user:
            return not premise.reported_by(user)

        return False

    def is_singular(self, contention):
        result = contention.premises.all().aggregate(
            max_sibling=Max('sibling_count'))
        return result['max_sibling'] <= 1


class HomeView(TemplateView, PaginationMixin):
    template_name = "index.html"
    tab_class = "featured"

    paginate_by = 20

    def get_context_data(self, **kwargs):
        contentions = self.get_contentions()
        if self.request.user.is_authenticated():
            notifications_qs = self.get_unread_notifications()
            notifications = list(notifications_qs)
            self.mark_as_read(notifications_qs)
        else:
            notifications = None
        return super(HomeView, self).get_context_data(
            channels=self.get_channels(),
            next_page_url=self.get_next_page_url(),
            tab_class=self.tab_class,
            notifications=notifications,
            has_next_page=self.has_next_page(),
            announcements=self.get_announcements(),
            contentions=contentions, **kwargs)

    def get_announcements(self):
        return Post.objects.filter(is_announcement=True)

    def get_unread_notifications(self):
        return (self.request.user
                .notifications
                .filter(is_read=False)[:5])

    def mark_as_read(self, notifications):
        pks = notifications.values_list("id", flat=True)
        (self.request.user
         .notifications
         .filter(id__in=pks)
         .update(is_read=True))

    def get_contentions(self, paginate=True):
        contentions = (Contention
                       .objects
                       .language()
                       .filter(is_featured=True)
                       .order_by("-date_modification"))

        if not contentions.exists():
            contentions = Contention.objects.language().annotate(
                premise_count=Sum("premises"),
            ).order_by("-premise_count")

        if paginate:
            contentions = (contentions[self.get_offset(): self.get_limit()])

        return contentions

    def get_channels(self):
        return Channel.objects.filter(
            language=normalize_language_code(get_language())
        ).order_by('order')


class NotificationsView(LoginRequiredMixin, HomeView):
    template_name = "notifications.html"

    def get_context_data(self, **kwargs):
        notifications_qs = self.request.user.notifications.all()[:40]
        notifications = list(notifications_qs)
        self.mark_as_read(notifications_qs)
        return super(HomeView, self).get_context_data(
            notifications=notifications,
            **kwargs)


class FallaciesView(HomeView, PaginationMixin):
    tab_class = "fallacies"
    template_name = "fallacies.html"
    paginate_by = 10

    def get_context_data(self, **kwargs):
        language = normalize_language_code(get_language())
        fallacies = (Report
                     .objects
                     .filter(reason__isnull=False,
                             contention__language=language)
                     .order_by('-id')
                     [self.get_offset():self.get_limit()])
        return super(FallaciesView, self).get_context_data(
            fallacies=fallacies,
            **kwargs)


class SearchView(HomeView):
    tab_class = 'search'
    template_name = 'search/search.html'
    partial_templates = {
        'contentions': 'search/contention.html',
        'users': 'search/profile.html',
        'premises': 'search/premise.html'
    }

    method_mapping = {'contentions': "get_contentions",
                      'users': "get_users",
                      'premises': "get_premises"}

    def dispatch(self, request, *args, **kwargs):
        self.type = request.GET.get('type', 'contentions')
        if not self.method_mapping.get(self.type):
            raise Http404()
        return super(SearchView, self).dispatch(request, *args, **kwargs)

    def get_keywords(self):
        return self.request.GET.get('keywords') or ''

    def is_json(self):
        return (self.request.is_ajax() or
                self.request.GET.get('json'))

    def has_next_page(self):
        method = getattr(self, self.method_mapping[self.type])
        total = method().count()
        return total > (self.get_offset() + self.paginate_by)

    def get_search_bundle(self):
        method = getattr(self, self.method_mapping[self.type])
        return [{'template': self.partial_templates[self.type],
                 'object': item} for item in method()]

    def get_context_data(self, **kwargs):
        return super(SearchView, self).get_context_data(
            results=self.get_search_bundle(),
            **kwargs)

    def get_next_page_url(self):
        offset = self.get_offset() + self.paginate_by
        return '?offset=%(offset)s&keywords=%(keywords)s&type=%(type)s' % {
            "offset": offset,
            "type": self.type,
            "keywords": self.get_keywords()
        }

    def get_premises(self, paginate=True):
        keywords = self.request.GET.get('keywords')
        if not keywords or len(keywords) < 3:
            result = Premise.objects.none()
        else:
            result = (Premise.objects.filter(
                argument__language=normalize_language_code(get_language()),
                text__contains=keywords))
            if paginate:
                result = result[self.get_offset():self.get_limit()]
        return result

    def get_users(self, paginate=True):
        keywords = self.request.GET.get('keywords')
        if not keywords or len(keywords) < 2:
            result = Profile.objects.none()
        else:
            result = (Profile.objects.filter(
                username__icontains=keywords))
            if paginate:
                result = result[self.get_offset():self.get_limit()]
        return result

    def get_contentions(self, paginate=True):
        keywords = self.request.GET.get('keywords')
        if not keywords or len(keywords) < 2:
            result = Contention.objects.none()
        else:
            result = (Contention
                      .objects
                      .filter(title__icontains=keywords,
                              language=normalize_language_code(get_language())))

            if paginate:
                result = result[self.get_offset():self.get_limit()]

        return result

    def render_to_response(self, context, **response_kwargs):
        """
        Returns a JSON response, transforming 'context' to make the payload.
        """
        if not self.is_json():
            return super(SearchView, self).render_to_response(
                context, **response_kwargs)

        results = [{
                       "id": result['object'].id,
                       "label": unicode(result['object'])
                   } for result in context['results']]

        return HttpResponse(
            json.dumps(results),
            dict(content_type='application/json', **response_kwargs)
        )


class NewsView(HomeView):
    tab_class = "news"

    def get_contentions(self, paginate=True):
        contentions = (
            Contention
                .objects
                .language()
                .filter(is_published=True)
                .order_by('-date_modification')
        )

        if paginate:
            contentions = contentions[self.get_offset():self.get_limit()]

        return contentions


class FeaturedJSONView(HomeView):
    def render_to_response(self, context, **response_kwargs):
        contentions = [contention.get_overview_bundle()
                       for contention in self.get_contentions()]
        return HttpResponse(
            json.dumps({"contentions": contentions},
                       cls=DjangoJSONEncoder),
            content_type="application/json"
        )


class NewsJSONView(NewsView):
    def render_to_response(self, context, **response_kwargs):
        contentions = [contention.get_overview_bundle()
                       for contention in self.get_contentions()]
        return HttpResponse(
            json.dumps({"contentions": contentions},
                       cls=DjangoJSONEncoder),
            content_type="application/json"
        )


class StatsView(HomeView):
    tab_class = "stats"
    template_name = "stats.html"
    partial_templates = {
        Profile: "stats/profile.html",
        Contention: "stats/contention.html",
        Premise: "stats/premise.html",
    }

    method_mapping = {
        "active_users": "get_active_users",
        "user_karma": "get_user_karma",
        "disgraced_users": "get_disgraced_users",
        "supported_premises": "get_supported_premises",
        "fallacy_premises": "get_fallacy_premises",
        "crowded_contentions": "get_crowded_contentions",
    }

    time_ranges = [7, 30]

    def get_context_data(self, **kwargs):
        return super(StatsView, self).get_context_data(
            stats=self.get_stats_bundle(),
            stats_type=self.get_stats_type(),
            days=self.days,
            **kwargs)

    def get_stats_type(self):
        return self.request.GET.get("what")

    def build_time_filters(self, date_field="date_creation"):
        days = self.request.GET.get("days")

        if not days or days == "all":
            self.days = None
            return {}

        try:
            days = int(days)
        except (TypeError, ValueError):
            days = None

        if not days or days not in self.time_ranges:
            raise Http404()

        self.days = days

        field_expression = "%s__gt" % date_field

        return {
            field_expression: timezone.now() - timedelta(days=days)
        }

    def get_stats_bundle(self):
        stat_type = self.get_stats_type()
        if stat_type not in self.method_mapping:
            raise Http404()
        method = getattr(self, self.method_mapping[stat_type])
        return [
            {
                "template": self.partial_templates[type(item)],
                "object": item
            } for item in method()
            ]

    def get_active_users(self):
        return Profile.objects.annotate(
            premise_count=Sum("user_premises"),
        ).filter(
            premise_count__gt=0,
            **self.build_time_filters(date_field="user_premises__date_creation")
        ).order_by("-premise_count")[:10]

    def get_user_karma(self):
        return Profile.objects.filter(
            karma__gt=0,
            **self.build_time_filters(date_field="user_premises__date_creation")
        ).order_by("-karma", "id").distinct()[:10]

    def get_disgraced_users(self):
        return Profile.objects.annotate(
            report_count=Sum("user_premises__reports"),
        ).filter(
            report_count__gt=0,
            **self.build_time_filters(date_field="user_premises__date_creation")
        ).order_by("-report_count")[:10]

    def get_supported_premises(self):
        return Premise.objects.annotate(
            supporter_count=Sum("supporters")
        ).filter(
            argument__language=get_language(),
            supporter_count__gt=0,
            **self.build_time_filters(date_field="date_creation")
        ).order_by("-supporter_count")[:50]

    def get_fallacy_premises(self):
        return Premise.objects.annotate(
            report_count=Sum("reports"),
        ).filter(
            report_count__gt=0,
            **self.build_time_filters(date_field="date_creation")
        ).order_by("-report_count")[:10]

    def get_crowded_contentions(self):
        return Contention.objects.annotate(
            premise_count=Sum("premises"),
        ).filter(
            language=normalize_language_code(get_language()),
            premise_count__gt=0,
            **self.build_time_filters(date_field="date_creation")
        ).order_by("-premise_count")[:10]


class UpdatedArgumentsView(HomeView):
    tab_class = "updated"

    def get_contentions(self, paginate=True):
        contentions = (Contention
                       .objects
                       .filter(is_published=True)
                       .order_by('-date_modification'))

        if paginate:
            contentions = contentions[self.get_offset():self.get_limit()]

        return contentions


class ControversialArgumentsView(HomeView):
    tab_class = "controversial"

    def get_contentions(self, paginate=True):
        last_week = now() - timedelta(days=3)
        contentions = (Contention
                       .objects
                       .annotate(num_children=Count('premises'))
                       .order_by('-num_children')
                       .filter(date_modification__gte=last_week))
        if paginate:
            return contentions[self.get_offset():self.get_limit()]

        return contentions


class AboutView(TemplateView):
    template_name = "about.html"

    def get_text_file(self):
        language = get_language()
        return render_to_string("about-%s.md" % language)

    def get_context_data(self, **kwargs):
        content = markdown(self.get_text_file())
        return super(AboutView, self).get_context_data(
            content=content, **kwargs)


class TosView(TemplateView):
    template_name = "tos.html"

    def get_context_data(self, **kwargs):
        content = markdown(render_to_string("tos.md"))
        return super(TosView, self).get_context_data(
            content=content, **kwargs)


class ArgumentCreationView(LoginRequiredMixin, CreateView):
    template_name = "premises/new_contention.html"
    form_class = ArgumentCreationForm

    help_texts = {
        'title': 'premises/examples/contention.html',
        'owner': 'premises/examples/owner.html',
        'sources': 'premises/examples/sources.html'
    }

    def get_form_class(self):
        form_class = self.form_class
        for key, value in self.help_texts.items():
            help_text = render_to_string(value)
            form_class.base_fields[key].help_text = help_text
        return form_class

    def form_valid(self, form):
        form.instance.user = self.request.user
        form.instance.ip_address = get_ip_address(self.request)
        form.instance.language = normalize_language_code(get_language())
        form.instance.is_published = True
        response = super(ArgumentCreationView, self).form_valid(form)
        form.instance.update_sibling_counts()
        form.instance.save_nouns()
        form.instance.save()
        return response


class ArgumentUpdateView(LoginRequiredMixin, UpdateView):
    template_name = "premises/edit_contention.html"
    form_class = ArgumentCreationForm

    def get_queryset(self):
        contentions = Contention.objects.all()
        if self.request.user.is_superuser:
            return contentions
        return contentions.filter(user=self.request.user)

    def form_valid(self, form):
        old_title = form.initial.get("title") or u""
        response = super(ArgumentUpdateView, self).form_valid(form)
        # the questions about words of the claim keep their words
        move_anchors(form.instance.premises.filter(parent__isnull=True),
                     old_title, form.instance.title)
        form.instance.update_sibling_counts()
        form.instance.nouns.clear()
        form.instance.save_nouns()
        form.instance.update_premise_weights()
        form.instance.save()
        return response


class RandomArgumentView(RedirectView):
    permanent = False

    def get_redirect_url(self, *args, **kwargs):
        argument = Contention.objects.annotate(
            premise_count=Count('premises')
        ).filter(
            premise_count__gt=2,
            language=normalize_language_code(get_language())
        ).order_by(
            '?'
        )[0]
        return argument.get_absolute_url()


class ArgumentPublishView(LoginRequiredMixin, DetailView):
    def get_queryset(self):
        return Contention.objects.filter(user=self.request.user)

    def post(self, request, slug):
        contention = self.get_object()
        contention.is_published = True
        contention.save()
        messages.info(request, u"Argument is published now.")
        return redirect(contention)


class ArgumentUnpublishView(LoginRequiredMixin, DetailView):
    def get_queryset(self):
        return Contention.objects.filter(user=self.request.user)

    def post(self, request, slug):
        contention = self.get_object()
        contention.is_published = False
        contention.save()
        messages.info(request, u"Argüman yayından kaldırıldı.")
        return redirect(contention)


class ArgumentDeleteView(LoginRequiredMixin, DetailView):
    def get_queryset(self):
        return Contention.objects.filter(user=self.request.user)

    def post(self, request, slug):
        contention = self.get_object()
        if check_content_deletion(contention):
            # remove notification
            Entry.objects.delete(contention.get_newsfeed_type(), contention.id)
            contention.delete()
            messages.info(request, u"Argument has been removed.")
            return redirect("home")
        else:
            messages.info(request, u"Argument cannot be deleted.")
            return redirect(contention)

    delete = post


class PremiseEditView(LoginRequiredMixin, UpdateView):
    template_name = "premises/edit_premise.html"
    form_class = PremiseEditForm

    help_texts = {
        'premise_type': 'premises/examples/premise_type.html',
        'text': 'premises/examples/premise.html',
        'sources': 'premises/examples/premise_source.html'
    }

    def get_form_class(self):
        form_class = self.form_class
        for key, value in self.help_texts.items():
            help_text = render_to_string(value)
            form_class.base_fields[key].help_text = help_text
        return form_class

    def get_queryset(self):
        premises = Premise.objects.all()
        if self.request.user.is_superuser or self.request.user.is_staff:
            return premises
        return premises.filter(user=self.request.user)

    def form_valid(self, form):
        old_text = form.initial.get("text") or u""
        response = super(PremiseEditView, self).form_valid(form)
        move_anchors(form.instance.children.all(), old_text,
                     form.instance.text)
        form.instance.argument.update_sibling_counts()
        return response

    def get_context_data(self, **kwargs):
        return super(PremiseEditView, self).get_context_data(**kwargs)


class PremiseCreationView(NextURLMixin, LoginRequiredMixin, CreateView):
    template_name = "premises/new_premise.html"
    form_class = PremiseCreationForm

    help_texts = {
        'premise_type': 'premises/examples/premise_type.html',
        'text': 'premises/examples/premise.html',
        'sources': 'premises/examples/premise_source.html'
    }

    def get_form_class(self):
        form_class = self.form_class
        for key, value in self.help_texts.items():
            help_text = render_to_string(value)
            form_class.base_fields[key].help_text = help_text
        return form_class

    def get_context_data(self, **kwargs):
        return super(PremiseCreationView, self).get_context_data(
            contention=self.get_contention(),
            view=self.get_view_name(),
            parent=self.get_parent(),
            **kwargs)

    def form_valid(self, form):
        contention = self.get_contention()
        form.instance.user = self.request.user
        form.instance.argument = contention
        form.instance.parent = self.get_parent()
        form.instance.is_approved = True
        form.instance.ip_address = get_ip_address(self.request)
        form.save()
        contention.update_sibling_counts()

        if form.instance.parent:
            added_premise_for_premise.send(sender=self,
                                           premise=form.instance)
        else:
            added_premise_for_contention.send(sender=self,
                                              premise=form.instance)

        contention.date_modification = timezone.now()
        contention.update_premise_weights()
        contention.save()

        return redirect(
            form.instance.get_absolute_url() +
            self.get_next_parameter()
        )

    def get(self, request, *args, **kwargs):
        # reasons are added in place on the claim page; the form stays for
        # browsers without JavaScript (?form=1)
        if not request.GET.get("form"):
            parent = self.get_parent()
            return redirect("%s?add=%s" % (
                self.get_contention().get_absolute_url(),
                parent.pk if parent else "root"))
        return super(PremiseCreationView, self).get(request, *args, **kwargs)

    def get_contention(self):
        return get_object_or_404(Contention, slug=self.kwargs['slug'])

    def get_parent(self):
        parent_pk = self.kwargs.get("pk")
        if parent_pk:
            return get_object_or_404(Premise, pk=parent_pk)


class PremiseSupportView(NextURLMixin, LoginRequiredMixin, View):
    def get_premise(self):
        premises = Premise.objects.exclude(user=self.request.user)
        return get_object_or_404(premises, pk=self.kwargs['pk'])

    def post(self, request, *args, **kwargs):
        premise = self.get_premise()
        premise.supporters.add(self.request.user)
        supported_a_premise.send(sender=self, premise=premise,
                                 user=self.request.user)
        premise.argument.update_premise_weights()

        if request.is_ajax():
            return HttpResponse(status=201)

        return redirect(
            premise.get_parent().get_absolute_url() +
            self.get_next_parameter() +
            "#%s" % premise.pk
        )

    def get_contention(self):
        return get_object_or_404(Contention, slug=self.kwargs['slug'])


class PremiseUnsupportView(PremiseSupportView):
    def delete(self, request, *args, **kwargs):
        premise = self.get_premise()
        premise.supporters.remove(self.request.user)
        premise.argument.update_premise_weights()

        if request.is_ajax():
            return HttpResponse(status=204)

        return redirect(
            premise.get_parent().get_absolute_url() +
            self.get_next_parameter() +
            "#%s" % premise.pk
        )

    post = delete


class PremiseDeleteView(LoginRequiredMixin, View):
    def get_premise(self):
        if self.request.user.is_staff:
            premises = Premise.objects.all()
        else:
            premises = Premise.objects.filter(user=self.request.user)
        return get_object_or_404(premises,
                                 pk=self.kwargs['pk'])

    def delete(self, request, *args, **kwargs):
        premise = self.get_premise()
        premise.delete()
        premise.update_sibling_counts()
        contention = self.get_contention()
        if not contention.premises.exists():
            contention.is_published = False
            contention.save()
        contention.update_premise_weights()
        return redirect(contention)

    post = delete

    def get_contention(self):
        return get_object_or_404(Contention, slug=self.kwargs['slug'])


class ReportView(NextURLMixin, LoginRequiredMixin, CreateView):
    form_class = ReportForm
    template_name = "premises/report.html"

    def get_form_class(self):
        form = self.form_class
        help_text = render_to_string('premises/examples/fallacy.html')
        form.base_fields['fallacy_type'].help_text = help_text
        return form

    def get_context_data(self, **kwargs):
        return super(ReportView, self).get_context_data(
            premise=self.get_premise(),
            view=self.get_view_name(),
            **kwargs)

    def get_contention(self):
        return get_object_or_404(Contention, slug=self.kwargs['slug'])

    def get_premise(self):
        return get_object_or_404(Premise, pk=self.kwargs['pk'])

    def get_initial(self):
        return {
            'contention': self.get_contention(),
            'premise': self.get_premise(),
            'reporter': self.request.user
        }

    def form_invalid(self, form):
        if self.request.is_ajax():
            return HttpResponse(json.dumps({"errors": form.errors}),
                                status=400, content_type="application/json")
        return super(ReportView, self).form_invalid(form)

    def form_valid(self, form):
        contention = self.get_contention()
        premise = self.get_premise()
        form.instance.contention = contention
        form.instance.premise = premise
        form.instance.reporter = self.request.user
        form.save()
        reported_as_fallacy.send(sender=self, report=form.instance)
        contention.update_premise_weights()
        if self.request.is_ajax():
            return HttpResponse(json.dumps({"id": form.instance.pk}),
                                status=201, content_type="application/json")
        return redirect(
            premise.get_parent().get_absolute_url() +
            self.get_next_parameter() +
            "#%s" % premise.pk
        )


class RemoveReportView(NextURLMixin, LoginRequiredMixin, View):
    def get_premise(self):
        return get_object_or_404(Premise, pk=self.kwargs['pk'])

    def post(self, request, *args, **kwargs):
        premise = self.get_premise()
        premise.reports.filter(
            reporter=request.user,
            fallacy_type=request.GET.get('type')
        ).delete()
        return redirect(
            premise.get_parent().get_absolute_url() +
            self.get_next_parameter() +
            "#%s" % premise.pk
        )


class AssemblyRedirectView(RedirectView):
    """The assembly page became the claim page itself."""
    permanent = True

    def get_redirect_url(self, *args, **kwargs):
        return get_object_or_404(
            Contention, slug=kwargs["slug"]).get_absolute_url()


def display_name(user):
    return user.first_name or "guest-%s" % user.username[:4]


def serialize_branch(premise):
    return {
        "id": premise.id,
        "parent": premise.parent_id,
        "type": premise.premise_type,
        "class": premise.premise_class(),
        "label": unicode(premise.get_premise_type_display()),
        "text": premise.text,
        "anchor": premise.anchor(),
        "author": {"id": premise.user_id,
                   "name": display_name(premise.user)},
        "date": premise.date_creation.isoformat(),
        "weight": premise.weight,
        "has_tbt": bool(premise.tbt),
    }


class LiveJSONView(DetailView):
    """
    The claim's reasons in the order they were added. With ?tbt=1 each
    reason also carries its Time Based Text recording, to replay the session.
    """
    model = Contention

    def render_to_response(self, context, **response_kwargs):
        contention = self.object
        premises = (contention.published_premises(ignore_parent=True)
                    .select_related("user")
                    .order_by("date_creation"))
        with_tbt = bool(self.request.GET.get("tbt"))

        def bundle(premise):
            branch = serialize_branch(premise)
            if with_tbt:
                branch["tbt"] = json.loads(premise.tbt) if premise.tbt else None
            return branch

        return HttpResponse(json.dumps({
            "contention": {
                "id": contention.id,
                "title": contention.title,
                "slug": contention.slug,
                "owner": contention.owner,
                "author": {"id": contention.user_id,
                           "name": display_name(contention.user)},
            },
            "premises": [bundle(premise) for premise in premises],
        }), content_type="application/json")


class PremiseTBTView(DetailView):
    def get_queryset(self):
        return Premise.objects.filter(argument__slug=self.kwargs["slug"],
                                      is_approved=True)

    def render_to_response(self, context, **response_kwargs):
        return HttpResponse(self.object.tbt or "[]",
                            content_type="application/json")


def replay_tbt(recording, text=u""):
    """
    Applies a Time Based Text recording to `text` (empty by default) and
    returns the resulting text, or None if the recording is malformed.
    """
    for entry in recording:
        if not (isinstance(entry, list) and len(entry) == 4):
            return None
        delay, position, delete_count, inserted = entry
        if not (isinstance(delay, int) and isinstance(position, int) and
                isinstance(delete_count, int) and
                isinstance(inserted, basestring)):
            return None
        if (delay < 0 or position < 0 or delete_count < 0 or
                position + delete_count > len(text)):
            return None
        text = text[:position] + inserted + text[position + delete_count:]
    return text


def normalize_words(words):
    return [re.sub(r"\W+", u"", word, flags=re.UNICODE).lower()
            for word in words]


def find_anchor(words, start, end, text):
    """
    Returns the (start, end) word span of `words` that `text` names. The
    browser counts words in the rendered text, which can differ from the
    stored markdown, so the span is checked against the words themselves and
    looked up when it does not match.
    """
    wanted = [w for w in normalize_words(text.split()) if w]
    if not wanted:
        return None
    if (0 <= start <= end < len(words) and
            [w for w in normalize_words(words[start:end + 1]) if w] == wanted):
        return start, end
    normalized = normalize_words(words)
    for i in range(len(words)):
        if normalized[i:i + len(wanted)] == wanted:
            return i, i + len(wanted) - 1
    return None


class BranchCreationView(LoginRequiredMixin, View):
    """
    Creates a reason from the live map. Expects a JSON body:
    {"parent": id|null, "premise_type": int, "text": str,
     "anchor": {"start": int, "end": int, "text": str|null}|null,
     "tbt": [...]|null, "sources": str|null, "related_argument": id|null,
     "name": str|null}
    """
    MAX_TBT_ENTRIES = 5000

    def error(self, message):
        return HttpResponse(json.dumps({"error": message}), status=400,
                            content_type="application/json")

    def post(self, request, slug):
        contention = get_object_or_404(Contention, slug=slug)

        try:
            data = json.loads(request.body)
        except ValueError:
            return self.error("invalid JSON")
        if not isinstance(data, dict):
            return self.error("invalid JSON")

        premise_type = data.get("premise_type")
        if premise_type not in dict(PREMISE_TYPES):
            return self.error("unknown premise type")

        text = data.get("text")
        if not isinstance(text, basestring) or not text.strip():
            return self.error("text is required")
        text = text.strip()
        if len(text) > MAX_PREMISE_CONTENT_LENGTH:
            return self.error("text is too long")

        parent = None
        if data.get("parent") is not None:
            try:
                parent = contention.published_premises(
                    ignore_parent=True).get(pk=data["parent"])
            except (Premise.DoesNotExist, ValueError, TypeError):
                return self.error("unknown parent")

        premise = Premise(argument=contention, parent=parent,
                          premise_type=premise_type, text=text,
                          user=request.user, is_approved=True,
                          ip_address=get_ip_address(request))

        anchor = data.get("anchor")
        if anchor:
            if not isinstance(anchor, dict):
                return self.error("invalid anchor")
            words = premise.anchor_source_text().split()
            start, end = anchor.get("start"), anchor.get("end")
            if not (isinstance(start, int) and isinstance(end, int) and
                    0 <= start <= end < len(words)):
                return self.error("anchor is out of range")
            if isinstance(anchor.get("text"), basestring):
                span = find_anchor(words, start, end, anchor["text"])
                if span is None:
                    return self.error("the word is not in the text")
                start, end = span
            premise.anchor_start = start
            premise.anchor_end = end
            premise.anchor_text = u" ".join(words[start:end + 1])[:255]
        elif premise_type == SEMANTIC:
            return self.error("a semantic challenge needs a word")

        recording = data.get("tbt")
        if (isinstance(recording, list) and
                len(recording) <= self.MAX_TBT_ENTRIES and
                replay_tbt(recording) is not None and
                replay_tbt(recording).strip() == text):
            # keep the recording only when it really produces the text
            premise.tbt = json.dumps(recording, separators=(",", ":"))

        sources = data.get("sources")
        if isinstance(sources, basestring) and sources.strip():
            premise.sources = sources.strip()[:2000]

        related = data.get("related_argument")
        if related is not None:
            try:
                premise.related_argument = Contention.objects.get(pk=related)
            except (Contention.DoesNotExist, ValueError, TypeError):
                return self.error("unknown related claim")

        name = data.get("name")
        if isinstance(name, basestring) and name.strip():
            request.user.first_name = name.strip()[:30]
            request.user.save(update_fields=["first_name"])

        premise.save()
        contention.update_sibling_counts()

        if parent:
            added_premise_for_premise.send(sender=self, premise=premise)
        else:
            added_premise_for_contention.send(sender=self, premise=premise)

        contention.date_modification = timezone.now()
        contention.update_premise_weights()
        contention.save()

        premise = Premise.objects.select_related("user").get(pk=premise.pk)
        return HttpResponse(json.dumps(serialize_branch(premise)),
                            status=201, content_type="application/json")


def common_ends(old, new):
    """The length of the start and of the end that old and new share."""
    prefix = 0
    while (prefix < len(old) and prefix < len(new) and
           old[prefix] == new[prefix]):
        prefix += 1
    suffix = 0
    while (suffix < len(old) - prefix and suffix < len(new) - prefix and
           old[len(old) - 1 - suffix] == new[len(new) - 1 - suffix]):
        suffix += 1
    return prefix, suffix


def move_anchors(premises, old_text, new_text):
    """
    After a correction of old_text, points the anchors of `premises` (the
    questions about its words) to the same words in new_text. Words before
    and after the corrected part keep their anchor; an anchor on corrected
    words goes to the words that replaced them.
    """
    old, new = old_text.split(), new_text.split()
    prefix, suffix = common_ends(old, new)

    def place(index, is_end):
        if index < prefix:
            return index
        if index >= len(old) - suffix:
            return index + len(new) - len(old)
        return len(new) - suffix - 1 if is_end else prefix

    for premise in premises.filter(anchor_start__isnull=False):
        start = place(premise.anchor_start, False)
        end = place(premise.anchor_end, True)
        if not 0 <= start <= end < len(new):
            continue  # its words were removed: the thread hangs from the node
        premise.anchor_start = start
        premise.anchor_end = end
        premise.anchor_text = u" ".join(new[start:end + 1])[:255]
        premise.save(update_fields=["anchor_start", "anchor_end",
                                    "anchor_text"])


class PremiseTextView(LoginRequiredMixin, View):
    """
    Corrects the text of a reason from the live map (a typo, a word).
    Only its author (or the staff) can. Expects a JSON body:
    {"text": str, "tbt": [...]|null}
    "tbt" is the recording of the correction, from the old text. It is
    added to the reason's recording, so a replay types the correction too.
    """
    MAX_TBT_ENTRIES = 5000
    PAUSE = 1000  # ms before a correction without its own recording

    def error(self, message):
        return HttpResponse(json.dumps({"error": message}), status=400,
                            content_type="application/json")

    def post(self, request, slug, pk):
        premises = Premise.objects.filter(argument__slug=slug)
        if not (request.user.is_staff or request.user.is_superuser):
            premises = premises.filter(user=request.user)
        premise = get_object_or_404(premises, pk=pk)

        try:
            data = json.loads(request.body)
        except ValueError:
            return self.error("invalid JSON")
        if not isinstance(data, dict):
            return self.error("invalid JSON")

        text = data.get("text")
        if not isinstance(text, basestring):
            return self.error("text is required")
        text = text.strip()
        if not text and not premise.related_argument_id:
            return self.error("text is required")
        if len(text) > MAX_PREMISE_CONTENT_LENGTH:
            return self.error("text is too long")

        old_text = premise.text or u""
        if text != old_text:
            premise.text = text
            premise.tbt = self.add_correction(premise.tbt, data.get("tbt"),
                                              text)
            premise.save()
            move_anchors(premise.children.all(), old_text, text)

        premise = Premise.objects.select_related("user").get(pk=premise.pk)
        return HttpResponse(json.dumps(serialize_branch(premise)),
                            content_type="application/json")

    def add_correction(self, stored, correction, text):
        """
        The stored recording with the correction after it, so that it
        produces `text`; None when there is no usable recording.
        """
        if not stored:
            return None
        recording = json.loads(stored)
        old = replay_tbt(recording)
        if old is None:
            return None
        if not (isinstance(correction, list) and correction and
                len(recording) + len(correction) <= self.MAX_TBT_ENTRIES and
                replay_tbt(correction, old) is not None and
                replay_tbt(correction, old).strip() == text):
            # no recording of the correction: one edit, after a pause
            prefix, suffix = common_ends(old, text)
            correction = [[self.PAUSE, prefix, len(old) - prefix - suffix,
                           text[prefix:len(text) - suffix]]]
        return json.dumps(recording + correction, separators=(",", ":"))
