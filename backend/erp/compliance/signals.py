"""Keep the ETA document in step with its invoice: a voided invoice whose
document was never accepted is simply cancelled here. A document the Tax
Authority already accepted must be cancelled there too, so it is left valid
and the e-invoice queue flags it for the accountant."""

from django.db.models.signals import post_save
from django.dispatch import receiver
from django.utils import timezone

from erp.billing.models import Invoice

from .models import EInvoiceDocument


@receiver(post_save, sender=Invoice, dispatch_uid="compliance_invoice_voided")
def invoice_voided(sender, instance, **kwargs):
    if instance.status != "void":
        return
    EInvoiceDocument.objects.filter(invoice=instance, status__in=("draft", "ready", "invalid", "rejected")).update(
        status="cancelled", cancelled_at=timezone.now(), cancel_reason=f"Invoice voided: {instance.void_reason}"[:255]
    )
