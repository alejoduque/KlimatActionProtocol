import json

from django.core.urlresolvers import reverse
from django.test import TestCase
from django.test.utils import override_settings

from premises.models import (Contention, Premise, SUPPORT, OBJECTION,
                             OPPOSITION, CONTINUATION, SEMANTIC)
from premises.views import replay_tbt
from profiles.models import Profile


class ReplayTBTTest(TestCase):
    def test_applies_edits_in_order(self):
        recording = [[0, 0, 0, u"climate"], [120, 7, 0, u" justice"],
                     [300, 0, 1, u"C"]]
        self.assertEqual(replay_tbt(recording), u"Climate justice")

    def test_rejects_malformed_entries(self):
        self.assertIsNone(replay_tbt([[0, 0, 0]]))
        self.assertIsNone(replay_tbt([[0, 5, 0, u"x"]]))  # past the end
        self.assertIsNone(replay_tbt([[0, 0, 2, u"x"]]))  # deletes nothing
        self.assertIsNone(replay_tbt([[-1, 0, 0, u"x"]]))
        self.assertIsNone(replay_tbt([["0", 0, 0, u"x"]]))


class AssemblyTest(TestCase):
    host = "en.localhost:8000"

    def setUp(self):
        self.author = Profile.objects.create(username="author")
        self.user = Profile.objects.create(username="participant")
        self.user.set_password("secret")
        self.user.save()
        self.contention = Contention.objects.create(
            title=u"Climate justice begins with land as pedagogy",
            user=self.author, language="en", is_published=True)
        self.client.login(username="participant", password="secret")

    def branch(self, contention=None, **data):
        contention = contention or self.contention
        return self.client.post(
            reverse("contention_branch", args=[contention.slug]),
            json.dumps(data), content_type="application/json",
            HTTP_HOST=self.host)

    @override_settings(PREVENT_LANGUAGE_REDIRECTION=True)
    def test_claim_page_carries_the_live_config(self):
        response = self.client.get(
            reverse("contention_detail", args=[self.contention.slug]),
            HTTP_HOST="klap.example.org")
        self.assertEqual(response.status_code, 200)
        config = json.loads(response.context["live_config"])
        self.assertEqual(config["room"], "klap:%s" % self.contention.slug)
        self.assertIn("{id}", config["tbtUrl"])
        self.assertIn("{id}", config["reportUrl"])
        self.assertEqual(len(config["instruments"]), 8)
        self.assertTrue(all(i["help"] for i in config["instruments"]))
        self.assertTrue(config["fallacies"])
        self.assertContains(response, "live-strip")

    @override_settings(PREVENT_LANGUAGE_REDIRECTION=True)
    def test_old_assembly_address_leads_to_the_claim(self):
        response = self.client.get(
            reverse("contention_assembly", args=[self.contention.slug]),
            HTTP_HOST="klap.example.org")
        self.assertEqual(response.status_code, 301)
        self.assertTrue(response["Location"].endswith(
            "/%s" % self.contention.slug))

    @override_settings(PREVENT_LANGUAGE_REDIRECTION=True)
    def test_tree_fragment_for_the_live_map(self):
        Premise.objects.create(argument=self.contention, user=self.author,
                               premise_type=SUPPORT, text=u"soil teaches")
        response = self.client.get(
            reverse("contention_detail", args=[self.contention.slug]),
            {"partial": "tree"}, HTTP_HOST="klap.example.org")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, '<ul class="tree" data-level="1">')
        self.assertContains(response, "soil teaches")
        self.assertNotContains(response, "<html")

    @override_settings(PREVENT_LANGUAGE_REDIRECTION=True)
    def test_new_reason_page_opens_the_live_map(self):
        parent = Premise.objects.create(
            argument=self.contention, user=self.author,
            premise_type=SUPPORT, text=u"a")
        url = reverse("new_premise", args=[self.contention.slug])
        response = self.client.get(url, HTTP_HOST="klap.example.org")
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].endswith(
            "/%s?add=root" % self.contention.slug))
        response = self.client.get(
            reverse("insert_premise", args=[self.contention.slug, parent.pk]),
            HTTP_HOST="klap.example.org")
        self.assertTrue(response["Location"].endswith("?add=%s" % parent.pk))

    @override_settings(PREVENT_LANGUAGE_REDIRECTION=True)
    def test_the_form_still_works_without_javascript(self):
        url = reverse("new_premise", args=[self.contention.slug])
        response = self.client.get(url, {"form": 1}, HTTP_HOST="klap.example.org")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'name="text"')
        response = self.client.post(url, {"premise_type": SUPPORT,
                                          "text": u"from the form"},
                                    HTTP_HOST="klap.example.org")
        self.assertEqual(response.status_code, 302)
        self.assertTrue(Premise.objects.filter(text=u"from the form").exists())

    def test_report_answers_json_for_the_live_map(self):
        premise = Premise.objects.create(
            argument=self.contention, user=self.author,
            premise_type=SUPPORT, text=u"a")
        url = reverse("report_premise", args=[self.contention.slug, premise.pk])
        response = self.client.post(
            url, {"fallacy_type": "AppealToAuthority", "reason": u"only a title"},
            HTTP_HOST=self.host, HTTP_X_REQUESTED_WITH="XMLHttpRequest")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(premise.reports.count(), 1)
        response = self.client.post(
            url, {"fallacy_type": "AppealToAuthority", "reason": u"again"},
            HTTP_HOST=self.host, HTTP_X_REQUESTED_WITH="XMLHttpRequest")
        self.assertEqual(response.status_code, 400)
        self.assertIn("errors", json.loads(response.content))

    def test_creates_main_premise_and_keeps_the_recording(self):
        recording = [[400, 0, 0, u"we learn"], [90, 8, 0, u" from soil"]]
        response = self.branch(premise_type=SUPPORT, text=u"we learn from soil",
                               tbt=recording, name=u"Ana")
        self.assertEqual(response.status_code, 201)
        body = json.loads(response.content)
        premise = Premise.objects.get(pk=body["id"])
        self.assertIsNone(premise.parent)
        self.assertEqual(json.loads(premise.tbt), recording)
        self.assertEqual(body["author"]["name"], u"Ana")
        self.assertTrue(body["has_tbt"])

        tbt = self.client.get(
            reverse("premise_tbt", args=[self.contention.slug, premise.pk]),
            HTTP_HOST=self.host)
        self.assertEqual(json.loads(tbt.content), recording)

    def test_drops_a_recording_that_does_not_produce_the_text(self):
        response = self.branch(premise_type=SUPPORT, text=u"we learn from soil",
                               tbt=[[0, 0, 0, u"something else"]])
        self.assertEqual(response.status_code, 201)
        self.assertIsNone(Premise.objects.get(
            pk=json.loads(response.content)["id"]).tbt)

    def test_semantic_challenge_anchors_a_word_of_the_title(self):
        response = self.branch(premise_type=SEMANTIC,
                               text=u"to cultivate, inhabit, care for",
                               anchor={"start": 5, "end": 6})
        self.assertEqual(response.status_code, 201)
        body = json.loads(response.content)
        self.assertEqual(body["anchor"],
                         {"start": 5, "end": 6, "text": u"as pedagogy"})

    def test_semantic_challenge_needs_a_word(self):
        response = self.branch(premise_type=SEMANTIC, text=u"what is land?")
        self.assertEqual(response.status_code, 400)

    def test_anchor_out_of_range_is_refused(self):
        response = self.branch(premise_type=OBJECTION, text=u"no",
                               anchor={"start": 2, "end": 40})
        self.assertEqual(response.status_code, 400)

    def test_anchor_points_into_the_parent_premise(self):
        parent = Premise.objects.create(
            argument=self.contention, user=self.author,
            premise_type=SUPPORT, text=u"the baldio is residual territory")
        response = self.branch(parent=parent.pk, premise_type=SEMANTIC,
                               text=u"undefined, transitional",
                               anchor={"start": 1, "end": 1})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(json.loads(response.content)["anchor"]["text"],
                         u"baldio")

    def test_parent_must_belong_to_the_contention(self):
        other = Contention.objects.create(title=u"Another argument",
                                          user=self.author, language="en")
        foreign = Premise.objects.create(argument=other, user=self.author,
                                         premise_type=SUPPORT, text=u"x")
        response = self.branch(parent=foreign.pk, premise_type=SUPPORT,
                               text=u"y")
        self.assertEqual(response.status_code, 400)

    def test_refuses_unknown_type_and_empty_or_long_text(self):
        self.assertEqual(self.branch(premise_type=42, text=u"x").status_code, 400)
        self.assertEqual(self.branch(premise_type=SUPPORT, text=u"  ").status_code, 400)
        self.assertEqual(self.branch(premise_type=SUPPORT,
                                     text=u"x" * 301).status_code, 400)

    def test_sources_and_related_claim(self):
        other = Contention.objects.create(title=u"Land as pedagogy",
                                          user=self.author, language="en")
        response = self.branch(premise_type=SUPPORT, text=u"see the reading list",
                               sources=u"Undercommons, 2013",
                               related_argument=other.pk)
        self.assertEqual(response.status_code, 201)
        premise = Premise.objects.get(pk=json.loads(response.content)["id"])
        self.assertEqual(premise.sources, u"Undercommons, 2013")
        self.assertEqual(premise.related_argument, other)
        self.assertEqual(self.branch(premise_type=SUPPORT, text=u"x",
                                     related_argument=999999).status_code, 400)

    def test_anchor_is_found_by_its_words_in_markdown_text(self):
        parent = Premise.objects.create(
            argument=self.contention, user=self.author, premise_type=SUPPORT,
            text=u"the [baldio](http://example.org) is *residual* territory")
        # the page counts words of the rendered text: "residual" is word 3
        response = self.branch(parent=parent.pk, premise_type=SEMANTIC,
                               text=u"left over", anchor={
                                   "start": 3, "end": 3, "text": u"residual"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(json.loads(response.content)["anchor"],
                         {"start": 3, "end": 3, "text": u"*residual*"})
        response = self.branch(parent=parent.pk, premise_type=SEMANTIC,
                               text=u"x", anchor={
                                   "start": 1, "end": 1, "text": u"nowhere"})
        self.assertEqual(response.status_code, 400)

    def test_live_json_lists_reasons_and_recordings(self):
        recording = [[0, 0, 0, u"a"]]
        self.branch(premise_type=SUPPORT, text=u"a", tbt=recording)
        url = reverse("contention_live_json", args=[self.contention.slug])
        data = json.loads(self.client.get(url, HTTP_HOST=self.host).content)
        self.assertNotIn("tbt", data["premises"][0])
        data = json.loads(self.client.get(url, {"tbt": 1},
                                          HTTP_HOST=self.host).content)
        self.assertEqual(data["premises"][0]["tbt"], recording)

    def test_live_json_lists_branches_flat(self):
        main = json.loads(self.branch(premise_type=SUPPORT, text=u"a").content)
        self.branch(parent=main["id"], premise_type=OPPOSITION, text=u"b")
        response = self.client.get(
            reverse("contention_live_json", args=[self.contention.slug]),
            HTTP_HOST=self.host)
        data = json.loads(response.content)
        self.assertEqual(data["contention"]["title"], self.contention.title)
        self.assertEqual([(p["text"], p["parent"], p["class"])
                          for p in data["premises"]],
                         [(u"a", None, "because"),
                          (u"b", main["id"], "opposition")])

    def test_opposition_weakens_and_continuation_strengthens(self):
        main = Premise.objects.create(argument=self.contention,
                                      user=self.author,
                                      premise_type=SUPPORT, text=u"a")
        Premise.objects.create(argument=self.contention, user=self.author,
                               parent=main, premise_type=OPPOSITION, text=u"b")
        self.assertEqual(main.update_weight(), 0)
        Premise.objects.create(argument=self.contention, user=self.author,
                               parent=main, premise_type=CONTINUATION,
                               text=u"c")
        self.assertEqual(main.update_weight(), 1)


class CorrectionTest(TestCase):
    """The author corrects the text of a reason from the live map."""
    host = "en.localhost:8000"

    def setUp(self):
        self.author = Profile.objects.create(username="author")
        self.author.set_password("secret")
        self.author.save()
        self.other = Profile.objects.create(username="other")
        self.other.set_password("secret")
        self.other.save()
        self.contention = Contention.objects.create(
            title=u"Climate justice begins with land as pedagogy",
            user=self.author, language="en", is_published=True)
        self.premise = Premise.objects.create(
            argument=self.contention, user=self.author, premise_type=SUPPORT,
            text=u"the baldio is residaul territory",
            tbt=json.dumps([[0, 0, 0, u"the baldio is residaul territory"]]))
        self.client.login(username="author", password="secret")

    def correct(self, premise=None, **data):
        premise = premise or self.premise
        return self.client.post(
            reverse("premise_text", args=[self.contention.slug, premise.pk]),
            json.dumps(data), content_type="application/json",
            HTTP_HOST=self.host)

    def question(self, start, end, text):
        return Premise.objects.create(
            argument=self.contention, user=self.other, parent=self.premise,
            premise_type=SEMANTIC, text=u"?", anchor_start=start,
            anchor_end=end, anchor_text=text)

    def test_the_map_offers_edit_to_the_author_only(self):
        url = reverse("contention_detail", args=[self.contention.slug])
        response = self.client.get(url, {"partial": "tree"},
                                   HTTP_HOST="klap.example.org")
        self.assertContains(
            response, 'data-text="the baldio is residaul territory"')
        self.client.login(username="other", password="secret")
        response = self.client.get(url, {"partial": "tree"},
                                   HTTP_HOST="klap.example.org")
        self.assertNotContains(response, "edit-premise")

    def test_staff_can_edit_and_remove_any_reason_on_the_map(self):
        self.other.is_staff = True
        self.other.save()
        self.client.login(username="other", password="secret")
        response = self.client.get(
            reverse("contention_detail", args=[self.contention.slug]),
            {"partial": "tree"}, HTTP_HOST="klap.example.org")
        self.assertContains(response, "edit-premise")
        self.assertContains(response, "delete_premise")
        self.client.post(reverse("delete_premise", args=[
            self.contention.slug, self.premise.pk]), HTTP_HOST=self.host)
        self.assertFalse(Premise.objects.filter(pk=self.premise.pk).exists())

    def test_profile_of_someone_who_answered_with_new_types(self):
        Premise.objects.create(
            argument=self.contention, user=self.other, parent=self.premise,
            premise_type=CONTINUATION, text=u"so we walk")
        response = self.client.get(
            reverse("auth_profile", args=[self.other.username]),
            HTTP_HOST=self.host)
        self.assertEqual(response.status_code, 200)

    def test_author_corrects_a_typo(self):
        response = self.correct(text=u"the baldio is residual territory ")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content)["text"],
                         u"the baldio is residual territory")
        premise = Premise.objects.get(pk=self.premise.pk)
        self.assertEqual(premise.text, u"the baldio is residual territory")
        self.assertEqual(replay_tbt(json.loads(premise.tbt)), premise.text)

    def test_the_recording_of_the_correction_is_kept(self):
        correction = [[300, 19, 2, u""], [80, 19, 0, u"ua"]]
        self.correct(text=u"the baldio is residual territory",
                     tbt=correction)
        recording = json.loads(Premise.objects.get(pk=self.premise.pk).tbt)
        self.assertEqual(recording[1:], correction)

    def test_a_wrong_recording_becomes_one_edit(self):
        self.correct(text=u"the baldio is residual territory",
                     tbt=[[0, 0, 0, u"something else"]])
        recording = json.loads(Premise.objects.get(pk=self.premise.pk).tbt)
        self.assertEqual(recording[1], [1000, 19, 2, u"ua"])

    def test_a_reason_without_recording_keeps_none(self):
        Premise.objects.filter(pk=self.premise.pk).update(tbt=None)
        self.correct(text=u"the baldio is residual territory")
        self.assertIsNone(Premise.objects.get(pk=self.premise.pk).tbt)

    def test_only_the_author_can_correct(self):
        self.client.login(username="other", password="secret")
        self.assertEqual(self.correct(text=u"x").status_code, 404)
        self.assertEqual(Premise.objects.get(pk=self.premise.pk).text,
                         u"the baldio is residaul territory")

    def test_staff_can_correct(self):
        self.other.is_staff = True
        self.other.save()
        self.client.login(username="other", password="secret")
        self.assertEqual(self.correct(text=u"x").status_code, 200)

    def test_refuses_empty_or_long_text(self):
        self.assertEqual(self.correct(text=u"  ").status_code, 400)
        self.assertEqual(self.correct(text=u"x" * 301).status_code, 400)
        self.assertEqual(self.correct().status_code, 400)

    def test_questions_keep_their_words(self):
        on_typo = self.question(3, 3, u"residaul")
        after = self.question(4, 4, u"territory")
        before = self.question(1, 1, u"baldio")
        self.correct(text=u"the baldio is the residual common territory")
        self.assertEqual(
            Premise.objects.get(pk=before.pk).anchor(),
            {"start": 1, "end": 1, "text": u"baldio"})
        self.assertEqual(
            Premise.objects.get(pk=on_typo.pk).anchor(),
            {"start": 3, "end": 5, "text": u"the residual common"})
        self.assertEqual(
            Premise.objects.get(pk=after.pk).anchor(),
            {"start": 6, "end": 6, "text": u"territory"})

    def test_a_question_on_removed_words_stays(self):
        on_typo = self.question(3, 3, u"residaul")
        self.correct(text=u"the baldio is territory")
        self.assertEqual(Premise.objects.get(pk=on_typo.pk).anchor(),
                         {"start": 3, "end": 3, "text": u"residaul"})

    def test_claim_correction_moves_the_questions_on_its_words(self):
        question = Premise.objects.create(
            argument=self.contention, user=self.other, premise_type=SEMANTIC,
            text=u"?", anchor_start=6, anchor_end=6, anchor_text=u"pedagogy")
        save_nouns = Contention.save_nouns
        Contention.save_nouns = lambda contention: None  # needs NLTK data
        try:
            self.client.post(
                reverse("contention_edit", args=[self.contention.slug]),
                {"title": u"Climate justice starts with the land as pedagogy",
                 "owner": u"", "sources": u""}, HTTP_HOST=self.host)
        finally:
            Contention.save_nouns = save_nouns
        self.assertEqual(Premise.objects.get(pk=question.pk).anchor(),
                         {"start": 7, "end": 7, "text": u"pedagogy"})


class SitePagesTest(TestCase):
    host = "en.localhost:8000"

    def test_login_page_opens(self):
        response = self.client.get("/login/", HTTP_HOST=self.host)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'name="password"')

    def test_admin_and_login_without_slash(self):
        for page in ("admin", "login"):
            response = self.client.get("/" + page, HTTP_HOST=self.host)
            self.assertEqual(response.status_code, 302)
            self.assertTrue(response["Location"].endswith("/%s/" % page))

    def test_staff_logs_in(self):
        staff = Profile.objects.create(username="organizer", is_staff=True)
        staff.set_password("secret")
        staff.save()
        response = self.client.post(
            "/login/?next=/admin/",
            {"username": "organizer", "password": "secret"},
            HTTP_HOST=self.host)
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].endswith("/admin/"))
        self.assertEqual(int(self.client.session["_auth_user_id"]), staff.pk)

    def test_page_not_found_is_in_english(self):
        response = self.client.get("/no/such/page", HTTP_HOST=self.host)
        self.assertEqual(response.status_code, 404)
        self.assertContains(response, "We did not find this page.",
                            status_code=404)
