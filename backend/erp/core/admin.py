from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import AuditEntry, Clinic, Notification, Role, StoredFile, User


@admin.register(Clinic)
class ClinicAdmin(admin.ModelAdmin):
    list_display = ["name_en", "name_ar", "currency", "default_language"]


@admin.register(Role)
class RoleAdmin(admin.ModelAdmin):
    list_display = ["name_en", "name_ar", "code", "clinic", "is_system"]
    list_filter = ["clinic"]


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ["username", "first_name", "last_name", "clinic", "is_active"]
    list_filter = ["clinic", "is_active", "roles"]
    fieldsets = BaseUserAdmin.fieldsets + (("Clinic", {"fields": ("clinic", "roles", "phone", "language")}),)
    filter_horizontal = ["roles", "groups", "user_permissions"]


@admin.register(AuditEntry)
class AuditEntryAdmin(admin.ModelAdmin):
    list_display = ["timestamp", "user", "action", "content_type", "object_repr"]
    list_filter = ["action", "content_type", "clinic"]
    readonly_fields = [f.name for f in AuditEntry._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(StoredFile)
class StoredFileAdmin(admin.ModelAdmin):
    list_display = ["original_name", "kind", "clinic", "created_at"]
    list_filter = ["kind", "clinic"]


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ["channel", "subject", "status", "created_at"]
    list_filter = ["channel", "status"]
