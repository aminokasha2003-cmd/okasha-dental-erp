"""Appointment reminders over WhatsApp, in the patient's language.

Run daily (python manage.py send_reminders) or from the calendar's button.
Messages go through erp.core.notifications, so they only really leave the
clinic once a WhatsApp provider is configured.
"""

from datetime import timedelta

from django.utils import timezone

from erp.core.notifications import notify

from .models import Appointment

AR_DAYS = ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]


def reminder_text(appointment):
    patient, clinic = appointment.patient, appointment.clinic
    when = timezone.localtime(appointment.start)
    branch = appointment.branch
    if patient.language == "en":
        name = patient.name_en or patient.name_ar
        text = (
            f"Hello {name}, this is a reminder of your appointment at {clinic.name_en} ({branch.name_en}) "
            f"on {when:%A %d/%m/%Y} at {when:%H:%M}."
        )
        if clinic.phone:
            text += f" To confirm or change it, call {clinic.phone}."
        return text
    name = patient.name_ar or patient.name_en
    text = (
        f"مرحباً {name}، نذكّرك بموعدك في {clinic.name_ar} ({branch.name_ar}) "
        f"يوم {AR_DAYS[when.weekday()]} {when:%d/%m/%Y} الساعة {when:%H:%M}."
    )
    if clinic.phone:
        text += f" للتأكيد أو التغيير اتصل بنا على {clinic.phone}."
    return text


def due_reminders(clinic=None, day=None):
    """Booked or confirmed visits on `day` (default: tomorrow) that have not been reminded yet."""
    day = day or (timezone.localdate() + timedelta(days=1))
    qs = Appointment.objects.filter(
        status__in=("booked", "confirmed"),
        reminder_sent_at__isnull=True,
        start__date=day,
        patient__whatsapp_opt_in=True,
    ).select_related("patient", "clinic", "branch")
    if clinic is not None:
        qs = qs.filter(clinic=clinic)
    return qs


def send_reminders(clinic=None, day=None):
    """Send the due reminders. Returns (sent, failed) counts."""
    sent = failed = 0
    for appointment in due_reminders(clinic, day):
        notification = notify(
            appointment.clinic, "whatsapp", reminder_text(appointment), phone=appointment.patient.phone
        )
        if notification.status == "sent":
            appointment.reminder_sent_at = timezone.now()
            appointment.save(update_fields=["reminder_sent_at", "updated_at"])
            sent += 1
        else:
            failed += 1
    return sent, failed
