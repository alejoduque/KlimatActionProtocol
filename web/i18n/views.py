from django.conf import settings
from django.http import Http404, HttpResponseRedirect
from django.utils.http import is_safe_url


def set_language(request, code):
    """
    The language selector (es | en): keeps the choice in a cookie and goes
    back to the page in ?next=, or to the home page.
    """
    if code not in settings.AVAILABLE_LANGUAGES:
        raise Http404
    next_url = request.GET.get("next")
    if not is_safe_url(next_url, host=request.get_host()):
        next_url = "/"
    response = HttpResponseRedirect(next_url)
    response.set_cookie(settings.LANGUAGE_COOKIE_NAME, code,
                        max_age=365 * 24 * 60 * 60)
    return response
