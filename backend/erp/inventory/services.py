"""The only place stock quantities change. Every change is a StockMovement and
the lot row is locked while it is applied, so two users cannot both take the
last implant."""

from decimal import Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from .models import StockLot, StockMovement

Q3 = Decimal("0.001")


def fmt_qty(value):
    return f"{Decimal(value).quantize(Q3).normalize():f}"


def lot_for(clinic, item, branch, lot_number="", expiry_date=None, unit_cost=None, supplier=None, po_line=None):
    """Find or open the lot stock is received or counted into. Items without lot
    tracking always use their one blank-numbered lot at the branch."""
    lot_number = (lot_number or "").strip() if item.tracks_lots else ""
    if item.tracks_lots and not lot_number:
        raise ValidationError({"lot_number": f"{item.name_en} tracks lots, so give the lot number."})
    if not item.tracks_lots:
        expiry_date = None
    lot, created = StockLot.objects.select_for_update().get_or_create(
        clinic=clinic,
        item=item,
        branch=branch,
        lot_number=lot_number,
        defaults={
            "expiry_date": expiry_date,
            "unit_cost": unit_cost if unit_cost is not None else item.last_cost,
            "received_at": timezone.now(),
            "supplier": supplier,
            "purchase_order_line": po_line,
        },
    )
    if not created:
        if expiry_date and lot.expiry_date and expiry_date != lot.expiry_date:
            raise ValidationError(
                {"expiry_date": f"Lot {lot_number} is already recorded with expiry {lot.expiry_date}."}
            )
        if expiry_date and not lot.expiry_date:
            lot.expiry_date = expiry_date
            lot.save(update_fields=["expiry_date", "updated_at"])
    return lot


def move(lot, kind, quantity, *, unit_cost=None, note="", **links):
    """Apply a signed quantity to a lot and write the ledger row.

    Refuses to take a lot below zero; only a stock count adjustment may."""
    quantity = Decimal(quantity).quantize(Q3)
    if quantity == 0:
        raise ValidationError({"quantity": "The quantity cannot be zero."})
    if kind in StockMovement.OUTGOING and quantity > 0:
        quantity = -quantity
    with transaction.atomic():
        locked = StockLot.objects.select_for_update().select_related("item", "branch").get(pk=lot.pk)
        balance = locked.quantity + quantity
        if balance < 0 and kind != "adjust":
            where = f" lot {locked.lot_number}" if locked.lot_number else ""
            raise ValidationError(
                {
                    "quantity": (
                        f"Only {fmt_qty(locked.quantity)} {locked.item.get_unit_display()} of {locked.item.name_en}"
                        f"{where} at {locked.branch.name_en}."
                    )
                }
            )
        cost = locked.unit_cost if unit_cost is None else unit_cost
        if kind in ("receive", "transfer_in") and quantity > 0 and unit_cost is not None:
            # Weighted average when more of the same lot arrives at a new price.
            held = max(locked.quantity, Decimal("0"))
            total = held + quantity
            locked.unit_cost = ((held * locked.unit_cost + quantity * unit_cost) / total).quantize(Decimal("0.01"))
        locked.quantity = balance
        locked.save(update_fields=["quantity", "unit_cost", "updated_at"])
        lot.quantity, lot.unit_cost = locked.quantity, locked.unit_cost
        return StockMovement.objects.create(
            clinic=locked.clinic,
            item=locked.item,
            lot=locked,
            branch=locked.branch,
            kind=kind,
            quantity=quantity,
            balance_after=balance,
            unit_cost=cost,
            note=note[:255],
            **links,
        )


def usable_lots(clinic, item, branch):
    """Lots stock can be taken from, first expiry first out. Expired lots are left out."""
    today = timezone.localdate()
    return (
        StockLot.objects.select_for_update()
        .filter(clinic=clinic, item=item, branch=branch, quantity__gt=0)
        .filter(Q(expiry_date__isnull=True) | Q(expiry_date__gte=today))
        .order_by("expiry_date", "received_at", "id")
    )


def take(clinic, item, branch, quantity, kind, *, lot=None, note="", **links):
    """Take stock out: from the chosen lot, or first expiry first out across
    lots. Returns the movements written (one per lot touched)."""
    quantity = Decimal(quantity).quantize(Q3)
    if quantity <= 0:
        raise ValidationError({"quantity": "The quantity must be more than zero."})
    with transaction.atomic():
        if lot is not None:
            if lot.item_id != item.pk or lot.branch_id != branch.pk:
                raise ValidationError({"lot": f"That lot is not {item.name_en} at {branch.name_en}."})
            if kind == "use" and lot.expiry_date and lot.expiry_date < timezone.localdate():
                raise ValidationError({"lot": f"Lot {lot.lot_number} expired on {lot.expiry_date}."})
            return [move(lot, kind, -quantity, note=note, **links)]
        lots = list(usable_lots(clinic, item, branch))
        available = sum((x.quantity for x in lots), Decimal("0"))
        if available < quantity:
            raise ValidationError(
                {
                    "quantity": (
                        f"Only {fmt_qty(available)} {item.get_unit_display()} of {item.name_en} "
                        f"in date at {branch.name_en}."
                    )
                }
            )
        movements, left = [], quantity
        for candidate in lots:
            if left <= 0:
                break
            part = min(left, candidate.quantity)
            movements.append(move(candidate, kind, -part, note=note, **links))
            left -= part
        return movements


def transfer(clinic, item, source, target, quantity, *, lot=None, note=""):
    """Move stock between branches, keeping lot numbers, expiry and cost."""
    if source.pk == target.pk:
        raise ValidationError({"to_branch": "Choose a different branch."})
    with transaction.atomic():
        outs = take(clinic, item, source, quantity, "transfer_out", lot=lot, note=note, other_branch=target)
        ins = []
        for out in outs:
            src = out.lot
            dest = lot_for(clinic, item, target, src.lot_number, src.expiry_date, unit_cost=src.unit_cost, supplier=src.supplier)
            ins.append(move(dest, "transfer_in", -out.quantity, unit_cost=src.unit_cost, note=note, other_branch=source))
        return outs + ins
