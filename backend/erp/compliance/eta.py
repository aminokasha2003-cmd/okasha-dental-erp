"""Egyptian Tax Authority (ETA) e-invoicing.

build_document() turns an issued invoice into the ETA "document" JSON
(version 1.0), validate() checks it the way the ETA would before it is sent,
and get_adapter() picks how it is sent:

- SimulationAdapter (the default): nothing leaves the server. It runs the
  checks the Tax Authority runs and answers with a made-up UUID, so the whole
  flow can be used and tested without credentials.
- EtaHttpClient: the real API (OAuth token + documentsubmissions). Only used
  when the clinic switched to live mode AND gave a client ID, secret, RIN and a
  signing service URL. ETA documents must carry a CAdES signature made with
  the clinic's USB token (or an HSM); that signing happens in the separate
  signing service, which receives the document and returns it signed.

The e-receipt (B2C point-of-sale receipt) system is a different API and is not
built here.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time
from decimal import ROUND_HALF_UP, Decimal

from django.conf import settings as django_settings
from django.utils import timezone

FIVE = Decimal("0.00001")
ZERO = Decimal("0")
EGYPT_GOVERNORATES = {
    "01", "02", "03", "04", "11", "12", "13", "14", "15", "16", "17", "18", "19", "21", "22", "23", "24", "25",
    "26", "27", "28", "29", "31", "32", "33", "34", "35", "88",
}
HOSTS = {
    "preprod": {"id": "https://id.preprod.eta.gov.eg", "api": "https://api.preprod.invoicing.eta.gov.eg", "portal": "https://preprod.invoicing.eta.gov.eg"},
    "prod": {"id": "https://id.eta.gov.eg", "api": "https://api.invoicing.eta.gov.eg", "portal": "https://invoicing.eta.gov.eg"},
}


def r5(value):
    """ETA amounts carry at most five decimals."""
    return Decimal(value).quantize(FIVE, rounding=ROUND_HALF_UP)


def num(value):
    """A JSON number with at most five decimals (no trailing zeros noise)."""
    d = r5(value)
    return float(d) if d != d.to_integral() else int(d)


# ------------------------------------------------------------ secrets


def _key():
    return hashlib.sha256(("eta-secret:" + django_settings.SECRET_KEY).encode()).digest()


def encrypt_secret(plain):
    """Encrypt with a keyed HMAC-SHA256 stream and add a MAC (stdlib only). Empty stays empty."""
    if not plain:
        return ""
    data = plain.encode()
    nonce = os.urandom(16)
    stream = b""
    counter = 0
    while len(stream) < len(data):
        stream += hmac.new(_key(), nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    cipher = bytes(a ^ b for a, b in zip(data, stream))
    tag = hmac.new(_key(), nonce + cipher, hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(nonce + tag + cipher).decode()


def decrypt_secret(token):
    if not token:
        return ""
    raw = base64.urlsafe_b64decode(token.encode())
    nonce, tag, cipher = raw[:16], raw[16:32], raw[32:]
    if not hmac.compare_digest(tag, hmac.new(_key(), nonce + cipher, hashlib.sha256).digest()[:16]):
        raise ValueError("The stored ETA secret cannot be read (the server key changed). Enter it again.")
    stream = b""
    counter = 0
    while len(stream) < len(cipher):
        stream += hmac.new(_key(), nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    return bytes(a ^ b for a, b in zip(cipher, stream)).decode()


# ------------------------------------------------------------ building


def national_id_problem(value):
    """None if this looks like a real Egyptian national ID, else why not (century, birth date, governorate)."""
    if not re.fullmatch(r"\d{14}", value or ""):
        return "must be 14 digits"
    century = {"2": 1900, "3": 2000}.get(value[0])
    if century is None:
        return "the first digit must be 2 or 3"
    try:
        born = date(century + int(value[1:3]), int(value[3:5]), int(value[5:7]))
    except ValueError:
        return "the birth date inside it is not a real date"
    if born > timezone.localdate():
        return "the birth date inside it is in the future"
    if value[7:9] not in EGYPT_GOVERNORATES:
        return "the governorate code inside it is not valid"
    return None


def issuer_address(conf, branch):
    addr = getattr(branch, "eta_address", None) if branch is not None else None
    pick = lambda field: (getattr(addr, field, "") if addr else "") or getattr(conf, field, "")  # noqa: E731
    return {
        "branchID": (addr.branch_code if addr else "0") or "0",
        "country": "EG",
        "governate": pick("governate"),
        "regionCity": pick("region_city"),
        "street": pick("street"),
        "buildingNumber": pick("building_number"),
        "postalCode": pick("postal_code"),
    }


def _utc_stamp(invoice):
    from datetime import timezone as dt_tz  # noqa: PLC0415

    local = timezone.localtime(invoice.created_at) if invoice.created_at else None
    if local is None or local.date() != invoice.issue_date:
        local = timezone.make_aware(datetime.combine(invoice.issue_date, time(12, 0)))
    return local.astimezone(dt_tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def item_code_for(line, conf, codes):
    code = codes.get(line.procedure_id) if line.procedure_id else None
    if code is not None:
        return code.item_type, code.item_code, code.unit_type or "EA"
    return conf.default_item_type or "EGS", conf.default_item_code, "EA"


def build_document(invoice, conf, codes=None):
    """The ETA document (v1.0) for an issued invoice, before signing.

    Line discounts and the invoice discount are both taken off before VAT (that
    is how the invoice itself works out tax), so the invoice discount is spread
    over the lines in proportion to their value."""
    from .models import EtaItemCode  # noqa: PLC0415

    if codes is None:
        codes = {c.procedure_id: c for c in EtaItemCode.objects.filter(clinic=invoice.clinic)}
    patient = invoice.patient
    lines = list(invoice.lines.all())
    rate = Decimal(invoice.tax_rate if invoice.tax_rate is not None else conf.default_tax_rate)
    subtype = conf.taxed_subtype if rate > 0 else conf.exempt_subtype

    gross = [Decimal(ln.unit_price) * ln.quantity - Decimal(ln.discount) for ln in lines]
    base = sum(gross, ZERO)
    extra = Decimal(invoice.discount or 0)
    shares, left = [], extra
    for i, g in enumerate(gross):
        share = left if i == len(gross) - 1 else (r5(extra * g / base) if base else ZERO)
        shares.append(share)
        left -= share

    out_lines = []
    t_sales = t_disc = t_net = t_tax = ZERO
    for ln, share in zip(lines, shares):
        item_type, item_code, unit = item_code_for(ln, conf, codes)
        unit_value = r5(ln.unit_price)
        sales = r5(unit_value * ln.quantity)
        disc = r5(Decimal(ln.discount) + share)
        net = r5(sales - disc)
        tax = r5(net * rate / 100)
        total = r5(net + tax)
        t_sales, t_disc, t_net, t_tax = t_sales + sales, t_disc + disc, t_net + net, t_tax + tax
        out_lines.append({
            "description": ln.description[:500],
            "itemType": item_type,
            "itemCode": item_code,
            "unitType": unit,
            "quantity": num(ln.quantity),
            "internalCode": (ln.procedure.code if ln.procedure_id else f"LINE-{ln.pk}"),
            "salesTotal": num(sales),
            "total": num(total),
            "valueDifference": 0,
            "totalTaxableFees": 0,
            "netTotal": num(net),
            "itemsDiscount": 0,
            "unitValue": {"currencySold": "EGP", "amountEGP": num(unit_value)},
            "discount": {"rate": 0, "amount": num(disc)},
            "taxableItems": [{"taxType": "T1", "amount": num(tax), "subType": subtype, "rate": num(rate)}],
        })
    total_amount = r5(t_net + t_tax)

    name = patient.name_ar or patient.name_en
    receiver = {"type": "P", "id": (patient.national_id or "").strip(), "name": name}
    if patient.address:
        receiver["address"] = {"country": "EG", "governate": "", "regionCity": "", "street": patient.address[:200], "buildingNumber": "0"}
    return {
        "issuer": {
            "type": "B",
            "id": conf.rin,
            "name": conf.issuer_name or invoice.clinic.name_ar or invoice.clinic.name_en,
            "address": issuer_address(conf, invoice.branch),
        },
        "receiver": receiver,
        "documentType": "I",
        "documentTypeVersion": "1.0",
        "dateTimeIssued": _utc_stamp(invoice),
        "taxpayerActivityCode": conf.activity_code,
        "internalID": invoice.number,
        "purchaseOrderReference": "",
        "salesOrderReference": "",
        "invoiceLines": out_lines,
        "totalSalesAmount": num(t_sales),
        "totalDiscountAmount": num(t_disc),
        "netAmount": num(t_net),
        "taxTotals": [{"taxType": "T1", "amount": num(t_tax)}],
        "extraDiscountAmount": 0,
        "totalItemsDiscountAmount": 0,
        "totalAmount": num(total_amount),
    }


# ------------------------------------------------------------ checking


def validate(doc, conf):
    """Problems that stop the document being sent, in words the accountant can act on."""
    errors = []
    issuer = doc.get("issuer", {})
    if not conf.is_registered:
        errors.append("The clinic is not marked as registered for e-invoicing (E-invoices › Settings).")
    if not re.fullmatch(r"\d{9}", issuer.get("id") or ""):
        errors.append("The clinic's tax registration number (RIN) must be 9 digits.")
    if not re.fullmatch(r"\d{4}", doc.get("taxpayerActivityCode") or ""):
        errors.append("The activity code must be 4 digits (dental practice is 8623).")
    address = issuer.get("address", {})
    missing = [label for key, label in (("governate", "governorate"), ("regionCity", "city"), ("street", "street"), ("buildingNumber", "building number")) if not address.get(key)]
    if missing:
        errors.append(f"The clinic address for the Tax Authority is missing: {', '.join(missing)}.")
    receiver = doc.get("receiver", {})
    if not receiver.get("name"):
        errors.append("The patient has no name.")
    total = Decimal(str(doc.get("totalAmount", 0)))
    threshold = Decimal(conf.person_id_threshold)
    if receiver.get("type") == "P":
        if total >= threshold and not receiver.get("id"):
            errors.append(f"Invoices of {threshold:,.0f} EGP or more need the patient's national ID (add it to the patient's file).")
        if receiver.get("id") and not re.fullmatch(r"\d{14}", receiver["id"]):
            errors.append("The patient's national ID must be 14 digits.")
    lines = doc.get("invoiceLines", [])
    if not lines:
        errors.append("The invoice has no lines.")
    for ln in lines:
        if not ln.get("itemCode"):
            errors.append(f"“{ln.get('description')}” has no Tax Authority item code (E-invoices › Item codes).")
        elif ln.get("itemType") == "EGS" and not re.fullmatch(r"EG-\d{9}-[A-Za-z0-9_-]+", ln["itemCode"]):
            errors.append(f"“{ln.get('description')}”: EGS codes look like EG-<RIN>-<your code>, not {ln['itemCode']}.")
        elif ln.get("itemType") == "GS1" and not re.fullmatch(r"\d{8,14}", ln["itemCode"]):
            errors.append(f"“{ln.get('description')}”: GS1 codes are 8 to 14 digits.")
    # Totals must add up exactly, to five decimals.
    sums = {
        "totalSalesAmount": sum((r5(str(ln["salesTotal"])) for ln in lines), ZERO),
        "totalDiscountAmount": sum((r5(str(ln["discount"]["amount"])) for ln in lines), ZERO),
        "netAmount": sum((r5(str(ln["netTotal"])) for ln in lines), ZERO),
    }
    for key, value in sums.items():
        if r5(str(doc.get(key, 0))) != value:
            errors.append(f"{key} does not equal the sum of the lines.")
    for ln in lines:
        if r5(str(ln["salesTotal"])) != r5(r5(str(ln["unitValue"]["amountEGP"])) * Decimal(str(ln["quantity"]))):
            errors.append(f"“{ln.get('description')}”: sales total is not quantity × price.")
        if Decimal(str(ln["netTotal"])) < 0:
            errors.append(f"“{ln.get('description')}”: the discount is larger than the price.")
    tax = sum((r5(str(t["amount"])) for t in doc.get("taxTotals", [])), ZERO)
    if r5(str(doc.get("totalAmount", 0))) != r5(sums["netAmount"] + tax):
        errors.append("totalAmount is not the net amount plus taxes.")
    return errors


def authority_checks(doc):
    """Checks only the Tax Authority can make (it knows real IDs and who registered which code).
    The simulation imitates the common ones so their errors look like the real thing."""
    errors = []
    receiver = doc.get("receiver", {})
    if receiver.get("id"):
        problem = national_id_problem(receiver["id"])
        if problem:
            errors.append(f"Receiver national ID {receiver['id']} was refused: {problem}.")
    rin = doc.get("issuer", {}).get("id", "")
    for ln in doc.get("invoiceLines", []):
        code = ln.get("itemCode", "")
        if ln.get("itemType") == "EGS" and code.startswith("EG-") and code.split("-")[1] != rin:
            errors.append(f"Item code {code} is not registered to this taxpayer (it belongs to RIN {code.split('-')[1]}).")
    return errors


def portal_url(environment, uuid, long_id):
    if not uuid:
        return ""
    host = HOSTS.get(environment, HOSTS["preprod"])["portal"]
    return f"{host}/print/documents/{uuid}/share/{long_id}"


# ------------------------------------------------------------ sending


class SubmissionResult:
    def __init__(self, accepted=None, rejected=None, submission_id=""):
        self.accepted = accepted or {}  # internalID -> {"uuid", "longId", "status", "errors"}
        self.rejected = rejected or {}  # internalID -> [errors]
        self.submission_id = submission_id


def _token(text, length):
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    digest = hashlib.sha256(text.encode()).digest()
    value = int.from_bytes(digest, "big")
    out = []
    for _ in range(length):
        value, rem = divmod(value, 32)
        out.append(alphabet[rem])
    return "".join(out)


class SimulationAdapter:
    """Answers like the ETA would, without any network call."""

    simulated = True
    name = "simulation"

    def __init__(self, conf):
        self.conf = conf

    def submit(self, docs):
        batch = _token(json.dumps([d.get("internalID") for d in docs]) + timezone.now().isoformat(), 26)
        result = SubmissionResult(submission_id=batch)
        for doc in docs:
            errors = validate(doc, self.conf)
            if errors:
                result.rejected[doc["internalID"]] = errors
                continue
            uuid = _token(json.dumps(doc, sort_keys=True, ensure_ascii=False), 26)
            found = authority_checks(doc)
            result.accepted[doc["internalID"]] = {
                "uuid": uuid,
                "longId": _token(uuid + "long", 40) if not found else "",
                "status": "invalid" if found else "valid",
                "errors": found,
            }
        return result

    def status(self, uuid):
        return None  # the simulation decides at once

    def cancel(self, uuid, reason):
        return True


class EtaError(Exception):
    pass


class EtaHttpClient:
    """The real ETA API. Used only when live mode is fully configured (see EInvoiceSettings.live_ready)."""

    simulated = False
    name = "eta"
    timeout = 30

    def __init__(self, conf):
        self.conf = conf
        self.hosts = HOSTS.get(conf.environment, HOSTS["preprod"])
        self._access = None

    def _request(self, method, url, body=None, headers=None, form=False):
        headers = dict(headers or {})
        data = None
        if body is not None:
            if form:
                data = urllib.parse.urlencode(body).encode()
                headers["Content-Type"] = "application/x-www-form-urlencoded"
            else:
                data = json.dumps(body, ensure_ascii=False).encode()
                headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310 (fixed https hosts)
                text = res.read().decode() or "{}"
                return json.loads(text)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:500]
            raise EtaError(f"The Tax Authority answered {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise EtaError(f"Could not reach {url}: {exc.reason}") from exc

    def token(self):
        if self._access is None:
            data = self._request(
                "POST",
                f"{self.hosts['id']}/connect/token",
                {"grant_type": "client_credentials", "client_id": self.conf.client_id,
                 "client_secret": decrypt_secret(self.conf.client_secret_enc), "scope": "InvoicingAPI"},
                form=True,
            )
            self._access = data.get("access_token")
            if not self._access:
                raise EtaError("The Tax Authority did not return an access token; check the client ID and secret.")
        return self._access

    def sign(self, doc):
        """The signing service holds the USB token / HSM and returns the document with its signatures."""
        signed = self._request("POST", self.conf.signer_url, {"document": doc})
        signed = signed.get("document", signed)
        if not signed.get("signatures"):
            raise EtaError("The signing service returned the document without a signature.")
        return signed

    def submit(self, docs):
        signed = [self.sign(d) for d in docs]
        data = self._request(
            "POST", f"{self.hosts['api']}/api/v1.0/documentsubmissions", {"documents": signed},
            headers={"Authorization": f"Bearer {self.token()}"},
        )
        result = SubmissionResult(submission_id=data.get("submissionId") or "")
        for row in data.get("acceptedDocuments") or []:
            result.accepted[row.get("internalId")] = {"uuid": row.get("uuid", ""), "longId": row.get("longId", ""), "status": "submitted", "errors": []}
        for row in data.get("rejectedDocuments") or []:
            err = row.get("error") or {}
            details = [d.get("message", "") for d in err.get("details") or []] or [err.get("message", "Rejected.")]
            result.rejected[row.get("internalId")] = details
        return result

    def status(self, uuid):
        data = self._request("GET", f"{self.hosts['api']}/api/v1.0/documents/{uuid}/details", headers={"Authorization": f"Bearer {self.token()}"})
        status = (data.get("status") or "").lower()
        errors = []
        for step in (data.get("validationResults") or {}).get("validationSteps") or []:
            if (step.get("status") or "").lower() != "invalid":
                continue
            err = step.get("error") or {}
            inner = [d.get("error") or d.get("message", "") for d in err.get("innerError") or []]
            errors.extend(inner or [err.get("error") or step.get("name", "Invalid.")])
        return {"status": status, "longId": data.get("longId", ""), "errors": [e for e in errors if e]}

    def cancel(self, uuid, reason):
        self._request(
            "PUT", f"{self.hosts['api']}/api/v1.0/documents/state/{uuid}/state", {"status": "cancelled", "reason": reason},
            headers={"Authorization": f"Bearer {self.token()}"},
        )
        return True


def get_adapter(conf):
    """The real client only when live mode is fully set up; otherwise the simulation."""
    return EtaHttpClient(conf) if conf.live_ready else SimulationAdapter(conf)
