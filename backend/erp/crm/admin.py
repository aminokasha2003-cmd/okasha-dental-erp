from django.contrib import admin

from .models import Campaign, Feedback, Lead, RecallRule


@admin.register(Lead)
class LeadAdmin(admin.ModelAdmin):
    list_display = ["name_en", "name_ar", "phone", "source", "stage", "next_follow_up", "clinic"]
    list_filter = ["stage", "source"]


@admin.register(RecallRule)
class RecallRuleAdmin(admin.ModelAdmin):
    list_display = ["name_en", "kind", "interval_months", "is_active", "clinic"]


@admin.register(Campaign)
class CampaignAdmin(admin.ModelAdmin):
    list_display = ["name", "channel", "status", "sent_at", "clinic"]


@admin.register(Feedback)
class FeedbackAdmin(admin.ModelAdmin):
    list_display = ["patient", "score", "source", "answered_at", "clinic"]
