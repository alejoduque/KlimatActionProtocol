import uuid
from django.contrib.auth import login
from profiles.models import Profile

class GuestAuthenticationMiddleware(object):
    def process_request(self, request):
        # We check if user is authenticated. In Django 1.7, user.is_authenticated() is a method
        if not request.user.is_authenticated():
            guest_id = request.COOKIES.get('guest_session_id')
            if not guest_id:
                guest_id = str(uuid.uuid4())
            
            # Since some UUID might be long, let's limit it if needed
            # username max_length is 30 in Django 1.7
            username = guest_id[:30]

            user, created = Profile.objects.get_or_create(username=username)
            if created:
                user.set_unusable_password()
                user.save()

            # Assign backend so login() can work
            user.backend = 'django.contrib.auth.backends.ModelBackend'
            login(request, user)
            
            request._guest_session_id_to_set = guest_id

    def process_response(self, request, response):
        if hasattr(request, '_guest_session_id_to_set'):
            # Set cookie to last for 10 years
            response.set_cookie('guest_session_id', request._guest_session_id_to_set, max_age=315360000)
        return response
