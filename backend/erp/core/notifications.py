"""The one place that sends messages.

Modules call notify(); they never talk to WhatsApp or SMS providers directly.
Each channel's backend is set in settings.NOTIFICATION_BACKENDS, so choosing a
WhatsApp provider later means writing one backend class and changing a setting.
"""

import logging

from django.conf import settings
from django.utils import timezone
from django.utils.module_loading import import_string

from .models import Notification

logger = logging.getLogger(__name__)


class SendError(Exception):
    pass


class BaseBackend:
    def send(self, notification):
        """Deliver the message. Return a provider message ID, or raise SendError."""
        raise NotImplementedError


class InAppBackend(BaseBackend):
    """In-app messages are just stored; the app shows them to the recipient."""

    def send(self, notification):
        if notification.recipient_user_id is None:
            raise SendError("In-app notifications need a recipient user.")
        return ""


class LogBackend(BaseBackend):
    """Placeholder until a WhatsApp/SMS provider is chosen: logs instead of sending."""

    def send(self, notification):
        if not notification.recipient_phone:
            raise SendError("This channel needs a recipient phone number.")
        logger.info(
            "[%s] to %s: %s", notification.channel, notification.recipient_phone, notification.body
        )
        return "logged"


def get_backend(channel):
    path = settings.NOTIFICATION_BACKENDS.get(channel)
    if not path:
        raise SendError(f"No backend configured for channel {channel}.")
    return import_string(path)()


def notify(clinic, channel, body, *, user=None, phone="", subject=""):
    """Create a notification and try to send it right away. Returns the Notification."""
    notification = Notification.objects.create(
        clinic=clinic,
        channel=channel,
        recipient_user=user,
        recipient_phone=phone or (user.phone if user is not None else ""),
        subject=subject,
        body=body,
    )
    deliver(notification)
    return notification


def deliver(notification):
    try:
        notification.provider_message_id = get_backend(notification.channel).send(notification) or ""
        notification.status = "sent"
        notification.sent_at = timezone.now()
        notification.error = ""
    except SendError as exc:
        notification.status = "failed"
        notification.error = str(exc)
    except Exception as exc:  # a provider outage must not break the caller
        logger.exception("Notification %s failed", notification.pk)
        notification.status = "failed"
        notification.error = str(exc)
    notification.save(update_fields=["status", "sent_at", "error", "provider_message_id", "updated_at"])
    return notification
