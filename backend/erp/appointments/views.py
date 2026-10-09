from datetime import datetime, timedelta

from django.db import transaction
from django.db.models import Exists, Max, OuterRef, Q
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from erp.core.api import ClinicScopedViewSet
from erp.masterdata.models import Branch
from erp.patients.models import Patient

from .models import Appointment
from erp.core.notifications import notify

from .reminders import due_reminders, reminder_text, send_reminders
from .serializers import AppointmentSerializer, clashes

# Moving into these statuses stamps the matching time.
STAMPS = {"arrived": "arrived_at", "in_chair": "seated_at", "completed": "completed_at"}


def local_day_bounds(day):
    start = timezone.make_aware(datetime.combine(day, datetime.min.time()))
    return start, start + timedelta(days=1)


class AppointmentViewSet(ClinicScopedViewSet):
    queryset = Appointment.objects.select_related("patient", "dentist", "procedure").prefetch_related("patient__alerts")
    serializer_class = AppointmentSerializer
    module = "appointments"
    required_actions = {"set_status": "edit", "queue": "view", "recalls": "view", "reminders": "view", "send_reminders": "edit", "remind": "edit"}
    pagination_class = None  # the calendar loads a day or a week at a time

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params
        if self.action == "list":
            day_from = parse_date(params.get("date_from") or params.get("date") or "")
            day_to = parse_date(params.get("date_to") or params.get("date") or "")
            if params.get("patient"):
                pass  # a patient's history is not limited to one day
            elif day_from is None:
                day_from = day_to = timezone.localdate()
            if day_from:
                qs = qs.filter(start__gte=local_day_bounds(day_from)[0])
            if day_to:
                if (day_to - (day_from or day_to)).days > 62:
                    raise ValidationError("Ask for two months at most.")
                qs = qs.filter(start__lt=local_day_bounds(day_to)[1])
        for param in ("branch", "chair", "dentist", "patient", "status"):
            if params.get(param):
                qs = qs.filter(**{param: params[param]})
        return qs

    def _lock_branch(self, branch_id):
        # Bookings at one branch are checked one at a time, so two receptionists
        # cannot both take the same slot.
        Branch.objects.select_for_update().filter(pk=branch_id, clinic=self.request.user.clinic).first()

    def create(self, request, *args, **kwargs):
        with transaction.atomic():
            self._lock_branch(request.data.get("branch"))
            return super().create(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        with transaction.atomic():
            instance = self.get_object()
            self._lock_branch(request.data.get("branch") or instance.branch_id)
            return super().update(request, *args, **kwargs)

    @action(detail=True, methods=["post"], url_path="status")
    def set_status(self, request, pk=None):
        """Move a visit along: confirm, check in, seat, complete, cancel, no-show, or undo a step."""
        with transaction.atomic():
            appointment = self.get_object()
            self._lock_branch(appointment.branch_id)
            new = request.data.get("status")
            if new not in dict(Appointment.STATUSES):
                raise ValidationError({"status": "Unknown status."})
            if new not in Appointment.TRANSITIONS[appointment.status]:
                raise ValidationError({"status": f"An appointment that is {appointment.status} cannot become {new}."})
            if new == "no_show" and appointment.start > timezone.now():
                raise ValidationError({"status": "A visit cannot be a no-show before its time."})
            if new == "cancelled":
                appointment.cancel_reason = str(request.data.get("cancel_reason", ""))[:255]
            if new in Appointment.ACTIVE and appointment.status not in Appointment.ACTIVE:
                # Re-booking a cancelled visit: the slot may have been taken since.
                found = clashes(appointment.pk, chair=appointment.chair, dentist=appointment.dentist,
                                start=appointment.start, end=appointment.end)
                if found:
                    raise ValidationError(found)
                appointment.cancel_reason = ""
            # Stepping back clears the stamps of the steps that are undone.
            order = ["booked", "arrived", "in_chair", "completed"]
            if new in order:
                for later in order[order.index(new) + 1:]:
                    setattr(appointment, STAMPS[later], None)
            if new in STAMPS and getattr(appointment, STAMPS[new]) is None:
                setattr(appointment, STAMPS[new], timezone.now())
            appointment.status = new
            appointment.save()
        return Response(self.get_serializer(appointment).data)

    @action(detail=False, methods=["get"])
    def queue(self, request):
        """Today's waiting room: who has arrived and who is in the chair, by arrival time."""
        start, end = local_day_bounds(timezone.localdate())
        qs = self.get_queryset().filter(start__gte=start, start__lt=end, status__in=("arrived", "in_chair"))
        qs = qs.order_by("arrived_at", "start")
        data = self.get_serializer(qs, many=True).data
        return Response({
            "waiting": [a for a in data if a["status"] == "arrived"],
            "in_chair": [a for a in data if a["status"] == "in_chair"],
        })

    @action(detail=False, methods=["get"])
    def recalls(self, request):
        """Patients due for a check-up: last finished visit over N months ago and nothing booked since."""
        try:
            months = min(max(int(request.query_params.get("months", 6)), 1), 36)
        except ValueError as exc:
            raise ValidationError({"months": "Give a number of months."}) from exc
        now = timezone.now()
        cutoff = now - timedelta(days=round(months * 30.4))
        patients = (
            Patient.objects.filter(clinic=request.user.clinic, is_active=True)
            .annotate(last_visit=Max("appointments__start", filter=Q(appointments__status="completed")))
            .filter(last_visit__lt=cutoff)
            .exclude(Exists(Appointment.objects.filter(patient=OuterRef("pk"), start__gte=now, status__in=("booked", "confirmed"))))
            .order_by("last_visit")
        )
        total = patients.count()
        rows = []
        for p in patients[:30]:
            last = p.appointments.filter(status="completed").select_related("procedure").order_by("-start").first()
            rows.append({
                "id": p.pk,
                "ar": p.name_ar,
                "en": p.name_en,
                "phone": p.phone,
                "whatsapp": p.whatsapp_opt_in,
                "language": p.language,
                "last_visit": p.last_visit,
                "last_procedure": {"en": last.procedure.name_en, "ar": last.procedure.name_ar} if last and last.procedure else None,
            })
        return Response({"count": total, "months": months, "results": rows})

    @action(detail=True, methods=["post"])
    def remind(self, request, pk=None):
        """Send this visit's WhatsApp reminder now."""
        appointment = self.get_object()
        if appointment.status not in ("booked", "confirmed"):
            raise ValidationError("Only booked or confirmed visits get a reminder.")
        if not appointment.patient.whatsapp_opt_in:
            raise ValidationError("This patient does not accept WhatsApp messages.")
        notification = notify(appointment.clinic, "whatsapp", reminder_text(appointment), phone=appointment.patient.phone)
        if notification.status != "sent":
            raise ValidationError(f"The reminder could not be sent: {notification.error}")
        appointment.reminder_sent_at = timezone.now()
        appointment.save(update_fields=["reminder_sent_at", "updated_at"])
        return Response(self.get_serializer(appointment).data)

    @action(detail=False, methods=["get"])
    def reminders(self, request):
        """How many reminders are waiting to go out for tomorrow."""
        return Response({"due": due_reminders(request.user.clinic).count()})

    @action(detail=False, methods=["post"], url_path="send-reminders")
    def send_reminders(self, request):
        sent, failed = send_reminders(request.user.clinic)
        return Response({"sent": sent, "failed": failed})
