from django.conf import settings
from django.contrib import admin
from django.http import FileResponse, Http404, JsonResponse
from django.urls import include, path, re_path


def health(request):
    return JsonResponse({"status": "ok"})


def web_app(request):
    """Serve the single-page app's index.html for every non-API path."""
    index = settings.FRONTEND_DIST / "index.html"
    if not index.exists():
        raise Http404("The web app has not been built.")
    return FileResponse(index.open("rb"), content_type="text/html")


urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", health),
    path("api/", include("erp.core.urls")),
    path("api/masterdata/", include("erp.masterdata.urls")),
    path("api/patients/", include("erp.patients.urls")),
    path("api/appointments/", include("erp.appointments.urls")),
    path("api/clinical/", include("erp.clinical.urls")),
    path("api/billing/", include("erp.billing.urls")),
]

# Must stay last: everything that is not the API, admin or a static file is the web app.
urlpatterns.append(re_path(r"^(?!api/|admin/|static/).*$", web_app))
