import csv
from datetime import date, timedelta

from django.http import HttpResponse
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from erp.core.api import ModulePermission, require_clinic

from . import library


def period(params):
    today = timezone.localdate()
    try:
        start = date.fromisoformat(params["start"]) if params.get("start") else today.replace(day=1)
        end = date.fromisoformat(params["end"]) if params.get("end") else today
    except ValueError as exc:
        raise ValidationError({"start": "Use dates like 2026-10-09."}) from exc
    if end < start:
        raise ValidationError({"end": "The end date is before the start date."})
    if (end - start).days > 800:
        raise ValidationError({"start": "Ask for two years at most."})
    return start, end


class ReportsView(APIView):
    permission_classes = [ModulePermission]
    module = "reports"


class LibraryView(ReportsView):
    """The reports this user may open (each needs view on its source module)."""

    def get(self, request):
        return Response([
            {"key": key, "module": rights[0][0], "filters": filters, "period": has_period}
            for key, (_fn, rights, filters, has_period) in library.REPORTS.items()
            if library.allowed(request.user, key)
        ])


class ReportView(ReportsView):
    """One report as JSON, or as a CSV file with ?export=csv."""

    def get(self, request, key):
        if key not in library.REPORTS:
            raise NotFound("Unknown report.")
        if not library.allowed(request.user, key):
            raise PermissionDenied("Your role cannot see the records this report is built from.")
        clinic = require_clinic(request.user)
        fn, _rights, filters, _has_period = library.REPORTS[key]
        start, end = period(request.query_params)
        chosen = {f: request.query_params[f] for f in filters if request.query_params.get(f)}
        columns, rows = fn(clinic, start, end, chosen)
        totals = {}
        for c in columns:
            if c["type"] in ("money", "number") and c["key"] not in ("avg_days", "months", "average", "on_hand"):
                try:
                    total = sum(float(r[c["key"]] or 0) for r in rows)
                except (TypeError, ValueError):
                    continue
                totals[c["key"]] = f"{total:.2f}" if c["type"] == "money" else (int(total) if float(total).is_integer() else round(total, 2))
        if request.query_params.get("export") == "csv":
            return self.csv(key, columns, rows, totals, start, end, request.user.language)
        return Response({"key": key, "start": start, "end": end, "filters": chosen, "columns": columns, "rows": rows, "totals": totals})

    def csv(self, key, columns, rows, totals, start, end, lang):
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{key}-{start}-{end}.csv"'
        response.write("﻿")  # so Excel opens Arabic correctly
        writer = csv.writer(response)
        label = "ar" if lang == "ar" else "en"
        writer.writerow([c[label] for c in columns])

        def cell(value):
            if isinstance(value, dict):
                return value.get(label) or value.get("en", "")
            return "" if value is None else value
        for r in rows:
            writer.writerow([cell(r.get(c["key"])) for c in columns])
        if rows and totals:
            writer.writerow([("الإجمالي" if label == "ar" else "Total") if i == 0 else totals.get(c["key"], "") for i, c in enumerate(columns)])
        return response


class OverviewView(ReportsView):
    """The owner's dashboard: every module's headline figures for a period,
    next to the same figures for the period before."""

    def get(self, request):
        clinic = require_clinic(request.user)
        start, end = period(request.query_params)
        span = (end - start).days + 1
        prev_start, prev_end = start - timedelta(days=span), start - timedelta(days=1)
        return Response({
            "start": start,
            "end": end,
            "previous": {"start": prev_start, "end": prev_end},
            "current": library.kpis(request.user, clinic, start, end),
            "before": library.kpis(request.user, clinic, prev_start, prev_end),
            "trend": library.trend(request.user, clinic, start, end),
            "breakdowns": library.breakdowns(request.user, clinic, start, end),
        })
