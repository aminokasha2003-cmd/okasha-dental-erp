from django.urls import path
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from . import views

router = DefaultRouter()
router.register("roles", views.RoleViewSet, basename="role")
router.register("users", views.UserViewSet, basename="user")
router.register("audit", views.AuditEntryViewSet, basename="audit")
router.register("files", views.StoredFileViewSet, basename="file")
router.register("notifications", views.NotificationViewSet, basename="notification")

urlpatterns = [
    path("auth/token/", TokenObtainPairView.as_view(), name="token"),
    path("auth/refresh/", TokenRefreshView.as_view(), name="token-refresh"),
    path("me/", views.MeView.as_view(), name="me"),
    path("meta/", views.MetaView.as_view(), name="meta"),
    path("clinic/", views.ClinicView.as_view(), name="clinic"),
    *router.urls,
]
