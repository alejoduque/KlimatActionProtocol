DEFAULT_FROM_EMAIL = 'info@arguman.org'
POSTMARK_TOKEN = "xyz"
POSTMARK_API_URL = "https://api.postmarkapp.com/email"


DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql_psycopg2',
        'NAME': 'postgres',
        'USER': 'postgres',
        'HOST': 'db',
        'PORT': 5432,
    }
}
ALLOWED_HOSTS = ['*']
DEBUG = True

SERVER_EMAIL = 'info@arguman.org'
BASE_DOMAIN = 'localhost:8000' #your docker machine ip if running on virtual server
MONGODB_HOST = 'localhost' #your docker machine ip if running on virtual server

# CACHES = {
#     "default": {
#         "BACKEND": "redis_cache.cache.RedisCache",
#         "LOCATION": "127.0.0.1:6379:1"
#     }
# }

# the realtime relay runs on its own port in development (docker compose)
REALTIME_WS_URL = ':8001/_rooms'  # same hostname as the page, port 8001

# Docker's DNS sometimes takes 5 s to answer the IPv6 (AAAA) question for a
# container name, and Django looks the database up on every request. Resolve
# the containers once, IPv4 only, when the server starts (local only).
import socket as _socket
DATABASES['default']['HOST'] = _socket.gethostbyname(DATABASES['default']['HOST'])
MONGODB_HOST = _socket.gethostbyname(MONGODB_HOST)
