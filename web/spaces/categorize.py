# -*- coding: utf-8 -*-
"""
Suggests categories for an item, without any AI on the server: the host of a
link, the categories of the space that share a word stem with the item, and
words that the text repeats. The person always decides.
"""
import re
from collections import Counter
from urlparse import urlparse

from nouns.utils import STEMMERS, stem_word

MAX_SUGGESTIONS = 5
MIN_REPEATS = 3
MIN_WORD_LENGTH = 5

WORD = re.compile(r"[^\W\d_]+", re.U)

STOPWORDS = set(u"""
about after again because before being between could every first other
their there these those through under where which while would should
sobre desde donde entre hasta para porque puede pueden según siempre
también tiene tienen todos todas como cuando este esta estos estas
nuestro nuestra quien cual cuales mientras hacer
""".split())


def words_of(text):
    return [word.lower() for word in WORD.findall(text or u"")]


def stems_of(words, language):
    return set(stem_word(word, language) for word in words)


def host_of(url):
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def suggest(existing, language, title=u"", body=u"", url=u""):
    """
    existing: the names of the categories of the space.
    """
    language = (language or "en")[:2]
    if language not in STEMMERS:
        language = "en"

    suggestions = []
    host = host_of(url) if url else ""
    if host:
        suggestions.append(host)

    words = words_of(title) + words_of(body)
    stems = stems_of(words, language)
    for name in existing:
        if stems_of(words_of(name), language) & stems:
            suggestions.append(name)

    taken = set(name.lower() for name in suggestions)
    known = set(name.lower() for name in existing)
    repeated = Counter(word for word in words
                       if len(word) >= MIN_WORD_LENGTH and
                       word not in STOPWORDS)
    for word, count in repeated.most_common(MAX_SUGGESTIONS):
        if count >= MIN_REPEATS and word not in taken and word not in known:
            suggestions.append(word)
            taken.add(word)
    return suggestions[:MAX_SUGGESTIONS]
