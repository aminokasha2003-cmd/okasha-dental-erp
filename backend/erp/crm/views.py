from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Prefetch, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import permissions
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from erp.appointments.models import Appointment
from erp.core.api import ClinicScopedViewSet, ModulePermission, require_clinic
from erp.patients.models import Patient, normalize_text
from erp.patients.serializers import PatientSerializer

from . import services
from .models import Campaign, CampaignRecipient, Feedback, Lead, LeadActivity, RecallContact, RecallRule
from .serializers import (
    CampaignRecipientSerializer,
    CampaignSerializer,
    FeedbackSerializer,
    LeadActivitySerializer,
    LeadSerializer,
    RecallContactSerializer,
    RecallRuleSerializer,
    money,
    named,
)

MODULE = "crm"


def parse_day(value, field, default=None):
    try:
        return date.fromisoformat(value) if value else default
    except ValueError as exc:
        raise ValidationError({field: "Use a date like 2026-10-09."}) from exc


def log(lead, user, kind, text="", stage_from="", stage_to=""):
    return LeadActivity.objects.create(
        clinic=lead.clinic, lead=lead, kind=kind, text=text, stage_from=stage_from, stage_to=stage_to, created_by=user
    )


def set_stage(lead, stage, user, lost_reason="", note=""):
    if stage not in dict(Lead.STAGES):
        raise ValidationError({"stage": "Unknown stage."})
    if stage == "lost" and lost_reason not in dict(Lead.LOST_REASONS):
        raise ValidationError({"lost_reason": "Say why the lead was lost."})
    if stage == lead.stage and stage != "lost":
        return lead
    old = lead.stage
    lead.stage = stage
    lead.lost_reason = lost_reason if stage == "lost" else ""
    lead.stage_changed_at = timezone.now()
    if stage in ("won", "lost"):
        lead.next_follow_up = None
    lead.updated_by = user
    lead.save()
    log(lead, user, "stage", note, old, stage)
    return lead


class LeadViewSet(ClinicScopedViewSet):
    queryset = Lead.objects.select_related("interest", "assigned_to", "patient").prefetch_related(
        Prefetch("activities", queryset=LeadActivity.objects.order_by("-created_at", "-id"), to_attr="recent_activities")
    )
    serializer_class = LeadSerializer
    module = MODULE
    pagination_class = None
    required_actions = {"stage": "edit", "convert": "edit", "consultation": "edit", "activities": "view", "duplicates": "view"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if self.action != "list":
            return qs
        if p.get("stage"):
            qs = qs.filter(stage__in=p["stage"].split(","))
        if p.get("open") == "1":
            qs = qs.filter(stage__in=Lead.OPEN_STAGES)
        if p.get("board") == "1":
            # Open leads plus the ones closed in the last 30 days.
            since = timezone.now() - timedelta(days=30)
            qs = qs.filter(Q(stage__in=Lead.OPEN_STAGES) | Q(stage_changed_at__gte=since))
        if p.get("source"):
            qs = qs.filter(source=p["source"])
        if p.get("assigned_to") == "me":
            qs = qs.filter(assigned_to__user=self.request.user)
        elif p.get("assigned_to"):
            qs = qs.filter(assigned_to=p["assigned_to"])
        if p.get("follow_up") == "due":
            qs = qs.filter(stage__in=Lead.OPEN_STAGES, next_follow_up__lte=timezone.localdate())
        if p.get("patient"):
            qs = qs.filter(patient=p["patient"])
        for word in normalize_text(p.get("search", "")).split():
            qs = qs.filter(search_text__contains=word.lstrip("+0") if word.lstrip("+").isdigit() else word)
        return qs[:500]

    def perform_create(self, serializer):
        lead = serializer.save(clinic=require_clinic(self.request.user), stage_changed_at=timezone.now())
        log(lead, self.request.user, "note", lead.notes or "")

    @action(detail=False, methods=["get"])
    def duplicates(self, request):
        exclude = request.query_params.get("exclude")
        return Response(services.duplicates(request.user.clinic, request.query_params.get("phone", ""), exclude_lead=exclude or None))

    @action(detail=True, methods=["post"])
    def stage(self, request, pk=None):
        lead = self.get_object()
        set_stage(lead, request.data.get("stage"), request.user, str(request.data.get("lost_reason", "")), str(request.data.get("note", ""))[:2000])
        return Response(self.get_serializer(self.get_queryset().get(pk=lead.pk)).data)

    @action(detail=True, methods=["get", "post"])
    def activities(self, request, pk=None):
        lead = self.get_object()
        if request.method == "GET":
            return Response(LeadActivitySerializer(lead.activities.select_related("created_by"), many=True).data)
        if not request.user.has_module_perm(MODULE, "edit"):
            raise PermissionDenied("Your role does not allow this.")
        ser = LeadActivitySerializer(data={**request.data, "lead": lead.pk}, context={"request": request})
        ser.is_valid(raise_exception=True)
        ser.save(clinic=lead.clinic, created_by=request.user)
        follow = request.data.get("next_follow_up")
        if follow is not None:
            lead.next_follow_up = parse_day(follow, "next_follow_up")
        if lead.stage == "new" and ser.validated_data["kind"] in ("call", "whatsapp", "sms", "visit"):
            lead.save(update_fields=["next_follow_up", "updated_at"])
            set_stage(lead, "contacted", request.user)
        else:
            lead.save(update_fields=["next_follow_up", "updated_at"])
        return Response(self.get_serializer(self.get_queryset().get(pk=lead.pk)).data, status=201)

    @action(detail=True, methods=["post"])
    def convert(self, request, pk=None):
        """Open a patient file from the lead, or link the lead to an existing patient."""
        if not request.user.has_module_perm("patients", "create"):
            raise PermissionDenied("Your role cannot register patients.")
        with transaction.atomic():
            lead = Lead.objects.select_for_update().get(pk=self.get_object().pk)
            if lead.patient_id:
                raise ValidationError("This lead is already a patient.")
            existing = request.data.get("patient")
            if existing:
                patient = get_object_or_404(Patient, clinic=lead.clinic, pk=existing)
            else:
                data = {
                    "name_ar": lead.name_ar, "name_en": lead.name_en, "phone": lead.phone, "gender": lead.gender,
                    "language": lead.language, "whatsapp_opt_in": lead.whatsapp_opt_in,
                    "referral_source": Lead.PATIENT_SOURCE.get(lead.source, "other"), "home_branch": lead.branch_id,
                    **{k: v for k, v in request.data.items() if k != "patient"},
                }
                ser = PatientSerializer(data=data, context={"request": request})
                ser.is_valid(raise_exception=True)
                patient = ser.save(clinic=lead.clinic, created_by=request.user)
            lead.patient = patient
            lead.converted_at = timezone.now()
            lead.save(update_fields=["patient", "converted_at", "updated_at"])
            log(lead, request.user, "note", f"Patient file {patient.file_number}")
        return Response(self.get_serializer(self.get_queryset().get(pk=lead.pk)).data)

    @action(detail=True, methods=["post"])
    def consultation(self, request, pk=None):
        """Link the consultation booked for this lead and move it to 'consultation booked'."""
        lead = self.get_object()
        appt = get_object_or_404(Appointment, clinic=lead.clinic, pk=request.data.get("appointment"))
        if lead.patient_id != appt.patient_id:
            raise ValidationError({"appointment": "That appointment is for another patient."})
        lead.consultation = appt
        lead.next_follow_up = timezone.localtime(appt.start).date()
        lead.save(update_fields=["consultation", "next_follow_up", "updated_at"])
        when = timezone.localtime(appt.start)
        if lead.stage in ("new", "contacted"):
            set_stage(lead, "consultation", request.user, note=f"{when:%d/%m/%Y %H:%M}")
        else:
            log(lead, request.user, "visit", f"{when:%d/%m/%Y %H:%M}")
        return Response(self.get_serializer(self.get_queryset().get(pk=lead.pk)).data)


class RecallRuleViewSet(ClinicScopedViewSet):
    queryset = RecallRule.objects.prefetch_related("procedures")
    serializer_class = RecallRuleSerializer
    module = MODULE
    pagination_class = None
    http_method_names = ["get", "post", "patch", "put", "head", "options"]  # switched off, never deleted

    def get_queryset(self):
        services.ensure_default_rules(require_clinic(self.request.user))
        return super().get_queryset()


def recall_row(r, lang_rule=True):
    p = r["patient"]
    latest = r["attempts"][-1] if r["attempts"] else None
    return {
        "key": f"{p.pk}-{r['rule'].pk}",
        "patient": {"id": p.pk, "file_number": p.file_number, "ar": p.name_ar, "en": p.name_en, "phone": p.phone,
                    "whatsapp": p.whatsapp_opt_in, "language": p.language, "home_branch": p.home_branch_id,
                    "preferred_dentist": p.preferred_dentist_id},
        "rule": {"id": r["rule"].pk, "ar": r["rule"].name_ar, "en": r["rule"].name_en, "months": r["rule"].interval_months},
        "anchor": r["anchor"],
        "due_date": r["due"],
        "status": r["status"],
        "days_overdue": r["days_overdue"],
        "last_visit": r["last_visit"],
        "attempts": len(r["attempts"]),
        "hidden": r["hidden"],
        "last_contact": {
            "outcome": latest.outcome, "channel": latest.channel, "note": latest.note, "at": latest.created_at,
            "snooze_until": latest.snooze_until,
            "by": (latest.created_by.get_full_name() or latest.created_by.username) if latest.created_by else "",
        } if latest else None,
    }


class RecallQueueView(APIView):
    """The recall queue: who is overdue or due in the next two weeks, per rule."""

    permission_classes = [ModulePermission]
    module = MODULE

    def get(self, request):
        clinic = require_clinic(request.user)
        p = request.query_params
        rows = services.recall_queue(clinic, include_hidden=p.get("hidden") == "1")
        if p.get("rule"):
            rows = [r for r in rows if str(r["rule"].pk) == p["rule"]]
        if p.get("status"):
            rows = [r for r in rows if r["status"] == p["status"]]
        if p.get("branch"):
            rows = [r for r in rows if str(r["patient"].home_branch_id) == p["branch"]]
        if p.get("search"):
            words = normalize_text(p["search"]).split()
            rows = [r for r in rows if all(w in r["patient"].search_text for w in words)]
        return Response({
            "count": len(rows),
            "overdue": sum(1 for r in rows if r["status"] == "overdue"),
            "due": sum(1 for r in rows if r["status"] == "due"),
            "results": [recall_row(r) for r in rows[:300]],
        })


class RecallContactViewSet(ClinicScopedViewSet):
    queryset = RecallContact.objects.select_related("created_by", "rule")
    serializer_class = RecallContactSerializer
    module = MODULE
    http_method_names = ["get", "post", "head", "options"]
    pagination_class = None

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("patient"):
            qs = qs.filter(patient=self.request.query_params["patient"])
        return qs[:200]

    def perform_create(self, serializer):
        serializer.save(clinic=require_clinic(self.request.user), created_by=self.request.user)


class CampaignViewSet(ClinicScopedViewSet):
    queryset = Campaign.objects.select_related("created_by", "clinic")
    serializer_class = CampaignSerializer
    module = MODULE
    required_actions = {"preview": "view", "send": "create", "recipients": "view", "responded": "edit"}

    def perform_create(self, serializer):
        serializer.save(clinic=require_clinic(self.request.user), created_by=self.request.user)

    def perform_destroy(self, instance):
        if instance.status == "sent":
            raise ValidationError("A sent campaign is kept for its results.")
        instance.delete()

    @action(detail=False, methods=["post"])
    def preview(self, request):
        """How many people the filters reach, how many can be messaged, and a sample message."""
        clinic = require_clinic(request.user)
        channel = request.data.get("channel", "whatsapp")
        filters = request.data.get("filters") or {}
        people = services.audience(clinic, filters)
        draft = Campaign(clinic=clinic, channel=channel, filters=filters,
                         message_en=request.data.get("message_en", ""), message_ar=request.data.get("message_ar", ""),
                         offer_date=parse_day(request.data.get("offer_date"), "offer_date"))
        reachable = [x for x in people if channel != "whatsapp" or x["consent"]]
        next_dates = services.next_visit_dates([x["patient_id"] for x in people[:200] if x["patient_id"]])
        sample = []
        for x in people[:40]:
            lang, body = services.message_for(draft, x, next_dates)
            sample.append({
                "kind": x["kind"], "id": x["obj"].pk, "ar": x["name_ar"], "en": x["name_en"], "phone": x["phone"],
                "consent": x["consent"], "language": lang, "body": body, "balance": money(x["balance"]),
            })
        return Response({
            "audience": len(people),
            "reachable": len(reachable),
            "no_consent": len(people) - len(reachable),
            "arabic": sum(1 for x in reachable if x["language"] != "en"),
            "english": sum(1 for x in reachable if x["language"] == "en"),
            "sample": sample,
        })

    @action(detail=True, methods=["post"])
    def send(self, request, pk=None):
        with transaction.atomic():
            campaign = Campaign.objects.select_for_update().get(pk=self.get_object().pk)
            if campaign.status == "sent":
                raise ValidationError("This campaign has already been sent.")
            counts = services.send_campaign(campaign, request.user)
        campaign.refresh_from_db()
        return Response({"counts": counts, "campaign": self.get_serializer(campaign).data})

    @action(detail=True, methods=["get"])
    def recipients(self, request, pk=None):
        campaign = self.get_object()
        results = services.campaign_results(campaign)["per_recipient"]
        rows = CampaignRecipientSerializer(campaign.recipients.select_related("patient", "lead"), many=True).data
        for row in rows:
            extra = results.get(row["id"], {"booked": 0, "responded": bool(row["responded_at"])})
            row.update(extra)
        return Response(rows)

    @action(detail=True, methods=["post"], url_path=r"recipients/(?P<rid>\d+)/responded")
    def responded(self, request, pk=None, rid=None):
        campaign = self.get_object()
        r = get_object_or_404(CampaignRecipient, campaign=campaign, pk=rid)
        r.responded_at = None if r.responded_at else timezone.now()
        r.save(update_fields=["responded_at"])
        return Response(CampaignRecipientSerializer(r).data)


class FeedbackViewSet(ClinicScopedViewSet):
    queryset = Feedback.objects.select_related("patient", "dentist", "appointment")
    serializer_class = FeedbackSerializer
    module = MODULE
    http_method_names = ["get", "post", "patch", "head", "options"]
    required_actions = {"request_link": "create", "visits": "view"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("patient"):
            qs = qs.filter(patient=p["patient"])
        if p.get("answered") == "1":
            qs = qs.filter(score__isnull=False)
        return qs

    def perform_create(self, serializer):
        appt = serializer.validated_data.get("appointment")
        score = serializer.validated_data.get("score")
        if score is None:
            raise ValidationError({"score": "Choose a score from 1 to 5."})
        serializer.save(clinic=require_clinic(self.request.user), created_by=self.request.user,
                        dentist=appt.dentist if appt else None, answered_at=timezone.now())

    @action(detail=False, methods=["post"], url_path="request-link")
    def request_link(self, request):
        """Make a link the patient can open to rate their visit."""
        clinic = require_clinic(request.user)
        appt = get_object_or_404(Appointment, clinic=clinic, pk=request.data.get("appointment"), status="completed")
        fb = Feedback.objects.filter(clinic=clinic, appointment=appt).first()
        if fb is None:
            fb = Feedback.objects.create(clinic=clinic, patient=appt.patient, appointment=appt, dentist=appt.dentist,
                                         source="link", created_by=request.user)
        return Response(self.get_serializer(fb).data, status=201)

    @action(detail=False, methods=["get"])
    def visits(self, request):
        """Finished visits of the last two weeks that have no feedback yet."""
        clinic = require_clinic(request.user)
        since = timezone.now() - timedelta(days=14)
        answered = Feedback.objects.filter(clinic=clinic, appointment__isnull=False).values("appointment")
        qs = (
            Appointment.objects.filter(clinic=clinic, status="completed", start__gte=since)
            .exclude(pk__in=answered).select_related("patient", "dentist", "procedure").order_by("-start")[:60]
        )
        return Response([
            {"id": a.pk, "start": a.start, "patient": {"id": a.patient_id, "file_number": a.patient.file_number, "ar": a.patient.name_ar, "en": a.patient.name_en,
                                                       "phone": a.patient.phone, "language": a.patient.language, "whatsapp": a.patient.whatsapp_opt_in},
             "dentist": named(a.dentist), "procedure": {"ar": a.procedure.name_ar, "en": a.procedure.name_en} if a.procedure else None}
            for a in qs
        ])


class PublicFeedbackView(APIView):
    """The patient's own page from the feedback link. No login; the token is the key."""

    permission_classes = [permissions.AllowAny]
    authentication_classes = []

    def get_object(self, token):
        return get_object_or_404(Feedback.objects.select_related("clinic", "patient", "dentist", "appointment"), token=token)

    def get(self, request, token):
        fb = self.get_object(token)
        return Response({
            "clinic": {"ar": fb.clinic.name_ar, "en": fb.clinic.name_en},
            "name": {"ar": fb.patient.name_ar.split()[0] if fb.patient.name_ar else "", "en": fb.patient.name_en.split()[0] if fb.patient.name_en else ""},
            "language": fb.patient.language,
            "dentist": named(fb.dentist),
            "visit_date": timezone.localtime(fb.appointment.start).date() if fb.appointment else None,
            "answered": fb.score is not None,
        })

    def post(self, request, token):
        fb = self.get_object(token)
        if fb.score is not None:
            raise ValidationError("Thank you, your answer is already in.")
        try:
            score = int(request.data.get("score"))
        except (TypeError, ValueError) as exc:
            raise ValidationError({"score": "Choose a score from 1 to 5."}) from exc
        if not 1 <= score <= 5:
            raise ValidationError({"score": "Choose a score from 1 to 5."})
        fb.score = score
        fb.comment = str(request.data.get("comment", ""))[:2000]
        fb.answered_at = timezone.now()
        fb.save(update_fields=["score", "comment", "answered_at", "updated_at"])
        return Response({"answered": True})


class SummaryView(APIView):
    """Counts for the CRM page header and the sidebar badge."""

    permission_classes = [ModulePermission]
    module = MODULE

    def get(self, request):
        clinic = require_clinic(request.user)
        today = timezone.localdate()
        leads = Lead.objects.filter(clinic=clinic)
        open_leads = leads.filter(stage__in=Lead.OPEN_STAGES)
        queue = services.recall_queue(clinic)
        callbacks = RecallContact.objects.filter(clinic=clinic, outcome="call_later", snooze_until=today).count()
        follow_ups = open_leads.filter(next_follow_up__lte=today).count()
        month_start = today.replace(day=1)
        fb = services.feedback_summary(clinic, today - timedelta(days=89), today)
        return Response({
            "open_leads": open_leads.count(),
            "new_leads_week": leads.filter(created_at__date__gte=today - timedelta(days=6)).count(),
            "pipeline_value": money(sum((x.estimated_value for x in open_leads), Decimal("0"))),
            "follow_ups_due": follow_ups,
            "recall_callbacks": callbacks,
            "badge": follow_ups + callbacks,
            "recalls_overdue": sum(1 for r in queue if r["status"] == "overdue"),
            "recalls_due": sum(1 for r in queue if r["status"] == "due"),
            "won_month": leads.filter(stage="won", stage_changed_at__date__gte=month_start).count(),
            "campaigns_month": Campaign.objects.filter(clinic=clinic, status="sent", sent_at__date__gte=month_start).count(),
            "nps": fb["nps"],
            "feedback_count": fb["count"],
            "feedback_average": fb["average"],
        })


class PatientCrmView(APIView):
    """The CRM section of a patient file: where they came from, leads, campaigns, recalls and feedback."""

    permission_classes = [ModulePermission]
    module = MODULE

    def get(self, request, patient_id):
        clinic = require_clinic(request.user)
        patient = get_object_or_404(Patient, clinic=clinic, pk=patient_id)
        leads = Lead.objects.filter(clinic=clinic, patient=patient).select_related("interest", "assigned_to").prefetch_related("activities__created_by")
        lead_rows = []
        for x in leads:
            lead_rows.append({
                "id": x.pk, "source": x.source, "stage": x.stage, "created_at": x.created_at, "converted_at": x.converted_at,
                "interest": {"ar": x.interest.name_ar, "en": x.interest.name_en} if x.interest else None, "interest_text": x.interest_text,
                "estimated_value": money(x.estimated_value), "assigned": named(x.assigned_to), "lost_reason": x.lost_reason,
                "activities": [
                    {"kind": a.kind, "text": a.text, "stage_from": a.stage_from, "stage_to": a.stage_to, "at": a.created_at,
                     "by": (a.created_by.get_full_name() or a.created_by.username) if a.created_by else ""}
                    for a in x.activities.all()[:12]
                ],
            })
        messages = CampaignRecipient.objects.filter(Q(patient=patient) | Q(lead__patient=patient)).select_related("campaign").order_by("-id")[:20]
        campaign_rows = []
        for m in messages:
            per = services.campaign_results(m.campaign)["per_recipient"].get(m.pk, {})
            campaign_rows.append({
                "id": m.campaign_id, "name": m.campaign.name, "channel": m.campaign.channel, "status": m.status,
                "sent_at": m.sent_at or m.campaign.sent_at, "body": m.body, "booked": per.get("booked", 0), "responded": per.get("responded", False),
            })
        recalls = [recall_row(r) for r in services.recall_queue(clinic, include_hidden=True, patient=patient, horizon=400)]
        contacts = RecallContactSerializer(RecallContact.objects.filter(patient=patient).select_related("created_by")[:10], many=True).data
        feedback = FeedbackSerializer(Feedback.objects.filter(patient=patient).select_related("dentist", "appointment"), many=True, context={"request": request}).data
        first = lead_rows[-1] if lead_rows else None
        return Response({
            "source": {"lead_source": first["source"] if first else None, "referral_source": patient.referral_source},
            "leads": lead_rows,
            "campaigns": campaign_rows,
            "recalls": recalls,
            "contacts": contacts,
            "feedback": feedback,
        })
