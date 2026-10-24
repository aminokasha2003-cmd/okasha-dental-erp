"""The public booking page's API: no login. Only what a visitor needs is shown
(branch names and hours, bookable services, dentists' names and free times);
nothing about patients or other bookings leaves the server."""

from datetime import date

from django.http import Http404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import permissions
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from erp.masterdata.models import StaffMember, WorkingHours

from . import services


class PublicView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def conf(self, slug):
        conf = services.booking_conf_for_slug(slug)
        if conf is None:
            raise Http404("Online booking is not available for this clinic.")
        return conf


def name(obj):
    return {"id": obj.pk, "en": obj.name_en, "ar": obj.name_ar}


def client_ip(request):
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    return (forwarded.split(",")[0].strip() if forwarded else request.META.get("REMOTE_ADDR")) or None


class PublicClinicView(PublicView):
    def get(self, request, slug):
        conf = self.conf(slug)
        clinic = conf.clinic
        branches = services.booking_branches(conf)
        hours = {}
        for h in WorkingHours.objects.filter(branch__in=branches):
            hours.setdefault(h.branch_id, []).append({
                "weekday": h.weekday, "closed": h.is_closed,
                "opens": h.opens_at.strftime("%H:%M") if h.opens_at else None, "closes": h.closes_at.strftime("%H:%M") if h.closes_at else None,
            })
        dentists = []
        if conf.allow_dentist_choice:
            for d in StaffMember.objects.filter(clinic=clinic, staff_type="dentist", is_active=True).prefetch_related("branches"):
                dentists.append({**name(d), "branches": [b.pk for b in d.branches.all()]})
        return Response({
            "clinic": {"en": clinic.name_en, "ar": clinic.name_ar, "phone": clinic.phone},
            "message": {"en": conf.message_en, "ar": conf.message_ar},
            "branches": [{**name(b), "address": {"en": b.address_en, "ar": b.address_ar}, "phone": b.phone, "hours": hours.get(b.pk, [])} for b in branches],
            "services": [
                {**name(p), "minutes": services.service_minutes(conf, p)}
                for p in conf.services.filter(is_active=True).order_by("category__sort_order", "name_en")
            ],
            "dentists": dentists,
            "days_ahead": conf.days_ahead,
            "today": timezone.localdate(),
        })


class PublicSlotsView(PublicView):
    def get(self, request, slug):
        conf = self.conf(slug)
        p = request.query_params
        branch, procedure, dentist = self.choices(conf, p.get("branch"), p.get("service"), p.get("dentist"))
        try:
            day = date.fromisoformat(p.get("date") or "")
        except ValueError as exc:
            raise ValidationError({"date": "Use a date like 2026-10-09."}) from exc
        minutes = services.service_minutes(conf, procedure)
        slots = services.free_slots(conf, branch, day, minutes, dentist)
        return Response({"date": day, "minutes": minutes, "slots": [timezone.localtime(s).isoformat() for s, _free in slots]})

    @staticmethod
    def choices(conf, branch_id, service_id, dentist_id):
        branches = {str(b.pk): b for b in services.booking_branches(conf)}
        branch = branches.get(str(branch_id))
        if branch is None:
            raise ValidationError({"branch": "Choose a branch."})
        procedure = conf.services.filter(is_active=True, pk=service_id).first() if service_id else None
        if service_id and procedure is None:
            raise ValidationError({"service": "This service cannot be booked online."})
        dentist = None
        if dentist_id:
            if not conf.allow_dentist_choice:
                raise ValidationError({"dentist": "Choosing a dentist is not available."})
            dentist = next((d for d in services.booking_dentists(conf.clinic, branch) if str(d.pk) == str(dentist_id)), None)
            if dentist is None:
                raise ValidationError({"dentist": "This dentist does not work at this branch."})
        return branch, procedure, dentist


class PublicRequestView(PublicView):
    def post(self, request, slug):
        conf = self.conf(slug)
        d = request.data
        # Honeypot: a field people never see. Bots fill it; pretend it worked.
        if d.get("website") or d.get("company"):
            return Response({"reference": services.new_reference(), "status": "pending"}, status=201)
        branch, procedure, dentist = PublicSlotsView.choices(conf, d.get("branch"), d.get("service"), d.get("dentist"))
        start = parse_datetime(d.get("start") or "")
        if start is None:
            raise ValidationError({"start": "Choose a time."})
        if timezone.is_naive(start):
            start = timezone.make_aware(start)
        name_ = (d.get("name") or "").strip()
        if len(name_) < 3:
            raise ValidationError({"name": "Enter your full name."})
        req = services.create_request(
            conf, branch=branch, procedure=procedure, dentist=dentist, start=start, name=name_, phone=d.get("phone") or "",
            note=d.get("note") or "", language=d.get("language") or "ar", consent=bool(d.get("consent")),
            ip=client_ip(request), user_agent=request.META.get("HTTP_USER_AGENT", ""),
        )
        notify_reception(req)
        return Response({
            "reference": req.reference, "status": req.status, "start": timezone.localtime(req.start).isoformat(),
            "branch": name(req.branch), "dentist": name(req.dentist) if req.dentist and req.dentist_chosen else None,
        }, status=201)


def notify_reception(req):
    """An in-app message to everyone who can confirm requests at the clinic."""
    from erp.core.models import User  # noqa: PLC0415
    from erp.core.notifications import notify  # noqa: PLC0415

    when = timezone.localtime(req.start).strftime("%d/%m %H:%M")
    for user in User.objects.filter(clinic=req.clinic, is_active=True).prefetch_related("roles"):
        if user.has_module_perm("appointments", "create") and not user.has_module_perm("clinical", "approve"):
            notify(req.clinic, "in_app", f"New online booking request from {req.name} for {when} at {req.branch.name_en}.", user=user, subject="Online booking")
