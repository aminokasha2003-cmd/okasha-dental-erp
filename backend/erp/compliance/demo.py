"""Phase 8 demo data: equipment with maintenance and work orders, licences,
six months of autoclave cycles with packs traced to patients (one failed
biological indicator with its recall list), e-invoices sent to the simulated
Tax Authority, and online booking requests. Called by erp.core.demo.seed."""

from collections import defaultdict
from datetime import datetime, time, timedelta
from decimal import Decimal

from django.utils import timezone

from erp.appointments.models import Appointment
from erp.billing.models import Invoice
from erp.inventory import services as stock
from erp.inventory.models import StockItem, Supplier
from erp.masterdata.models import Procedure
from erp.patients.models import Patient

from . import services
from .models import (
    BookingRequest,
    BookingSettings,
    ComplianceSettings,
    DailyChecklist,
    EInvoiceDocument,
    EInvoiceSettings,
    Equipment,
    EtaBranchAddress,
    EtaItemCode,
    InstrumentPack,
    Licence,
    MaintenancePlan,
    MaintenanceRecord,
    PackLoad,
    SterilizationCycle,
    WorkOrder,
    WorkOrderPart,
)

RIN = "512345678"
FRIDAY = 4


def wipe(clinic):
    c = clinic
    WorkOrderPart.objects.filter(clinic=c).delete()
    for model in (MaintenanceRecord, WorkOrder, MaintenancePlan, Licence, PackLoad, SterilizationCycle, InstrumentPack,
                  DailyChecklist, Equipment, EInvoiceDocument, EtaItemCode, EtaBranchAddress, EInvoiceSettings,
                  BookingRequest, BookingSettings, ComplianceSettings):
        model.objects.filter(clinic=c).delete()


def counts(clinic):
    c = clinic
    return {
        "equipment": Equipment.objects.filter(clinic=c).count(),
        "work orders": WorkOrder.objects.filter(clinic=c).count(),
        "autoclave cycles": SterilizationCycle.objects.filter(clinic=c).count(),
        "packs used on patients": PackLoad.objects.filter(clinic=c, patient__isnull=False).count(),
        "e-invoices": EInvoiceDocument.objects.filter(clinic=c).count(),
        "online requests": BookingRequest.objects.filter(clinic=c).count(),
    }


def aware(day, hh, mm=0):
    return timezone.make_aware(datetime.combine(day, time(hh, mm)))


class ComplianceDemo:
    def __init__(self, s):
        self.s = s
        self.c = s.clinic
        self.r = s.rng
        self.today = s.today
        self.now = s.now
        self.start = services.add_months(self.today, -6)

    def run(self):
        ComplianceSettings.for_clinic(self.c)
        self.equipment()
        self.sterilisation()
        self.maintenance()
        self.licences()
        self.einvoices()
        self.booking()

    # ------------------------------------------------------------ equipment
    def add(self, key, en, ar, category, branch, **extra):
        e = Equipment.objects.create(clinic=self.c, name_en=en, name_ar=ar, category=category, branch=self.s.branch[branch] if branch else None, **extra)
        self.eq[key] = e
        return e

    def equipment(self):
        s, r = self.s, self.r
        self.eq = {}
        sup = {x.name: x for x in Supplier.objects.filter(clinic=self.c)}
        cds, nile, nasr_store = sup.get("Cairo Dental Supplies"), sup.get("Nile Dental Trading"), sup.get("El Nasr Medical Store")
        years = lambda n: self.today - timedelta(days=int(365 * n))  # noqa: E731
        for code, chairs in s.chairs.items():
            for i, chair in enumerate(chairs):
                self.add(f"chair-{chair.pk}", f"Dental unit · {chair.name_en}", f"وحدة أسنان · {chair.name_ar}", "chair", code, chair=chair,
                         manufacturer="Sirona" if code == "nasr" else "Fedesa", model_name="Intego" if code == "nasr" else "Astral",
                         serial_number=f"DU-{2019 + i}{r.randint(10000, 99999)}", supplier=cds, purchase_date=years(4 - i * 0.6),
                         cost=Decimal(r.choice([185000, 210000, 240000])), warranty_end=years(2 - i * 0.6))
        self.add("ac-a", "Autoclave A (Lisa 22L)", "أوتوكلاف أ (ليزا ٢٢ لتر)", "autoclave", "nasr", manufacturer="W&H", model_name="Lisa 522",
                 serial_number="WH-LS5-118204", supplier=cds, purchase_date=years(3), cost=Decimal("165000"), warranty_end=years(1), cycles_before=3120)
        self.add("ac-b", "Autoclave B (Vacuklav)", "أوتوكلاف ب (فاكوكلاف)", "autoclave", "nasr", manufacturer="Melag", model_name="Vacuklav 41B+",
                 serial_number="MLG-41B-77310", supplier=cds, purchase_date=years(1.3), cost=Decimal("142000"), warranty_end=self.today + timedelta(days=260), cycles_before=410)
        self.add("ac-h", "Autoclave (Heliopolis)", "أوتوكلاف مصر الجديدة", "autoclave", "helio", manufacturer="Euronda", model_name="E10",
                 serial_number="EU-E10-55902", supplier=nile, purchase_date=years(2.2), cost=Decimal("118000"), warranty_end=years(0.2), cycles_before=1980)
        for code, ar in (("nasr", "مدينة نصر"), ("helio", "مصر الجديدة")):
            self.add(f"comp-{code}", f"Compressor ({s.branch[code].name_en})", f"كمبروسر ({ar})", "compressor", code, manufacturer="Cattani", model_name="AC 200",
                     serial_number=f"CT-{r.randint(100000, 999999)}", supplier=nasr_store, purchase_date=years(3.5), cost=Decimal("68000"))
            self.add(f"suction-{code}", f"Suction unit ({s.branch[code].name_en})", f"شفاط ({ar})", "suction", code, manufacturer="Dürr", model_name="VS 300",
                     serial_number=f"DR-{r.randint(100000, 999999)}", supplier=nasr_store, purchase_date=years(3.5), cost=Decimal("54000"))
            self.add(f"xray-{code}", f"Intraoral X-ray ({s.branch[code].name_en})", f"جهاز أشعة صغيرة ({ar})", "xray", code, manufacturer="Planmeca", model_name="ProX",
                     serial_number=f"PX-{r.randint(100000, 999999)}", supplier=cds, purchase_date=years(2.8), cost=Decimal("96000"), warranty_end=years(0.8))
            self.add(f"us-{code}", f"Ultrasonic cleaner ({s.branch[code].name_en})", f"جهاز تنظيف بالموجات ({ar})", "ultrasonic", code, manufacturer="Elma",
                     model_name="Elmasonic S30", serial_number=f"EL-{r.randint(10000, 99999)}", supplier=nile, purchase_date=years(2), cost=Decimal("14500"))
            self.add(f"cure-{code}", f"Curing light ({s.branch[code].name_en})", f"لمبة ضوئية ({ar})", "curing", code, manufacturer="Woodpecker",
                     model_name="LED.B", serial_number=f"WP-{r.randint(10000, 99999)}", supplier=nile, purchase_date=years(1), cost=Decimal("6500"), warranty_end=self.today + timedelta(days=120))
        self.add("scan-helio", "Intraoral scanner (Heliopolis)", "ماسح ضوئي داخل الفم (مصر الجديدة)", "scanner", "helio", manufacturer="Medit", model_name="i700",
                 serial_number="MD-i700-21877", supplier=cds, purchase_date=years(1.5), cost=Decimal("520000"), warranty_end=self.today + timedelta(days=45))
        self.add("scan-nasr", "Intraoral scanner (Nasr City)", "ماسح ضوئي داخل الفم (مدينة نصر)", "scanner", "nasr", manufacturer="3Shape", model_name="TRIOS 4",
                 serial_number="3S-T4-90215", supplier=cds, purchase_date=years(2.1), cost=Decimal("780000"), warranty_end=years(0.1))
        self.add("opg", "Panoramic X-ray (OPG)", "جهاز أشعة بانوراما", "opg", "nasr", manufacturer="Vatech", model_name="PaX-i", serial_number="VT-PXI-60331",
                 supplier=cds, purchase_date=years(3.2), cost=Decimal("640000"))
        self.add("cbct", "CBCT", "جهاز أشعة مقطعية CBCT", "cbct", "nasr", manufacturer="Carestream", model_name="CS 8100 3D", serial_number="CS-81-33019",
                 supplier=cds, purchase_date=years(1.8), cost=Decimal("1450000"), warranty_end=self.today + timedelta(days=180))
        self.add("mill", "Milling machine (lab)", "ماكينة التفريز (المعمل)", "milling", "nasr", manufacturer="Amann Girrbach", model_name="Ceramill Motion 2",
                 serial_number="AG-CM2-40418", supplier=sup.get("Pharaoh Lab Materials"), purchase_date=years(2.5), cost=Decimal("950000"))
        self.add("printer", "3D printer (lab)", "طابعة ثلاثية الأبعاد (المعمل)", "printer", "nasr", manufacturer="Formlabs", model_name="Form 3B+",
                 serial_number="FL-F3B-11872", supplier=sup.get("Pharaoh Lab Materials"), purchase_date=years(1.1), cost=Decimal("260000"), warranty_end=years(0.1))
        self.add("furnace", "Sintering furnace (lab)", "فرن تلبيد الزيركون (المعمل)", "furnace", "nasr", manufacturer="Ivoclar", model_name="Programat S1",
                 serial_number="IV-PS1-80177", supplier=sup.get("Pharaoh Lab Materials"), purchase_date=years(2.5), cost=Decimal("410000"))

    # ------------------------------------------------------------ sterilisation
    def sterilisation(self):
        s, r, c = self.s, self.r, self.c
        conf = ComplianceSettings.for_clinic(c)
        packs = {"nasr": [], "helio": []}
        defs = [("CS", "Exam & restorative cassette", "كاسيت كشف وحشو", "cassette", 10, 6),
                ("HP", "Handpiece set", "طقم هاند بيس", "handpiece", 6, 4),
                ("SUR", "Surgical extraction kit", "طقم خلع جراحي", "surgical", 3, 2),
                ("ENDO", "Endodontic kit", "طقم علاج عصب", "tray", 4, 2),
                ("IMP", "Implant surgical kit", "طقم جراحة زرع", "implant", 2, 1)]
        for prefix, en, ar, kind, n_nasr, n_helio in defs:
            for code, n, letter in (("nasr", n_nasr, "N"), ("helio", n_helio, "H")):
                for i in range(1, n + 1):
                    packs[code].append(InstrumentPack.objects.create(
                        clinic=c, code=f"{prefix}-{letter}{i:02d}", name_en=f"{en} {i}", name_ar=f"{ar} {i}", kind=kind,
                        branch=s.branch[code], contents="Mirror, probe, tweezers, excavator, plastic instrument" if kind == "cassette" else "",
                    ))
        machines = {"nasr": [self.eq["ac-a"], self.eq["ac-b"]], "helio": [self.eq["ac-h"]]}
        operators = {"nasr": s.staff.get("aya"), "helio": s.staff.get("omar")}
        number = {m.pk: m.cycles_before for ms in machines.values() for m in ms}
        # Packs needed per visit: everyone gets a cassette; fillings and root canals a handpiece set;
        # extractions a surgical kit; implants the implant kit.
        visits = defaultdict(list)
        for a in (Appointment.objects.filter(clinic=c, start__date__gte=self.start, start__lte=self.now, status__in=("completed", "in_chair"))
                  .select_related("procedure", "dentist").order_by("start")):
            visits[(s.branch_code[a.branch_id], timezone.localtime(a.start).date())].append(a)

        state = {p.pk: None for ps in packs.values() for p in ps}  # pack -> current load dict
        cycle_objs = []
        # The failed biological indicator: Nasr City autoclave B, a Sunday about three weeks ago.
        fail_day = self.today - timedelta(days=19)
        while fail_day.weekday() != 6:
            fail_day -= timedelta(days=1)
        day = self.start
        while day <= self.today:
            if day.weekday() == FRIDAY:
                day += timedelta(days=1)
                continue
            for code in ("nasr", "helio"):
                open_h = 10 if code == "nasr" else 12
                times = [(open_h - 1, 30), (open_h + 4, 0), (open_h + 8, 30)]
                ms = machines[code]
                # Morning Bowie-Dick test on each autoclave.
                for m in ms:
                    when = aware(day, open_h - 2, 50 + ms.index(m) * 5)
                    if when > self.now:
                        continue
                    number[m.pk] += 1
                    cycle_objs.append(dict(machine=m, cycle_number=number[m.pk], started_at=when, program="bowie_dick", temperature=Decimal("134.2"),
                                           pressure=Decimal("2.10"), hold_minutes=3, duration_minutes=22, air_removal_test="bowie_dick", air_removal_result="pass",
                                           operator=operators[code], loads=[]))
                day_visits = visits.get((code, day), [])
                for k, (hh, mm) in enumerate(times):
                    when = aware(day, hh, mm) + timedelta(minutes=r.randint(0, 20))
                    if when > self.now:
                        continue
                    # Use packs for the visits that started before this cycle (and after the previous one).
                    lo = aware(day, *times[k - 1]) if k else aware(day, 0)
                    for a in [v for v in day_visits if lo <= v.start < when]:
                        self.use_for_visit(a, packs[code], state)
                    dirty = [p for p in packs[code] if self.needs_cycle(state[p.pk], day)]
                    weekly_bi = day.weekday() == 6 and k == 0  # Sunday's first load carries the biological indicator
                    on_fail_day = day == fail_day and code == "nasr" and k == 0
                    if on_fail_day:
                        # That morning every cassette and handpiece set went through autoclave B.
                        dirty = [p for p in packs[code] if p.kind in ("cassette", "handpiece")]
                    if not dirty and not weekly_bi:
                        continue
                    for i, m in enumerate(ms):
                        chunk = dirty[i::len(ms)][:12]
                        if on_fail_day:
                            chunk = dirty if m == self.eq["ac-b"] else []
                        if not chunk and not weekly_bi:
                            continue
                        number[m.pk] += 1
                        temp = Decimal(r.choice(["134.3", "134.6", "134.9", "135.1", "134.4"]))
                        cyc = dict(machine=m, cycle_number=number[m.pk], started_at=when + timedelta(minutes=i * 7), program="134_wrapped", temperature=temp,
                                   pressure=Decimal(r.choice(["2.12", "2.15", "2.18", "2.20"])), hold_minutes=r.choice([4, 5, 5, 6]),
                                   duration_minutes=r.randint(42, 58), chemical_indicator="pass", operator=operators[code], loads=[])
                        if weekly_bi:
                            failed = day == fail_day and m == self.eq["ac-b"]
                            read = when + timedelta(days=2, hours=2)
                            cyc.update(bi_used=True, bi_lot=f"BI-{day:%y%m}{r.randint(10, 99)}",
                                       bi_result=("positive" if failed else "negative") if read <= self.now else "pending",
                                       bi_read_at=read if read <= self.now else None)
                            if failed:
                                cyc["notes"] = "Biological indicator positive after 48 h incubation. Autoclave B taken out of use and serviced; loads re-sterilised."
                        for p in chunk:
                            entry = {"pack": p, "cycle": cyc, "expires_on": day + timedelta(days=conf.pack_shelf_days), "used": None}
                            cyc["loads"].append(entry)
                            state[p.pk] = entry
                        cycle_objs.append(cyc)
                # Visits after the last cycle of the day.
                last = aware(day, *times[-1])
                for a in [v for v in day_visits if v.start >= last]:
                    self.use_for_visit(a, packs[code], state)
            day += timedelta(days=1)

        rows = []
        for cyc in cycle_objs:
            fields = {k: v for k, v in cyc.items() if k != "loads"}
            obj = SterilizationCycle(clinic=c, branch=fields["machine"].branch, **fields)
            obj.failure_reasons = obj.evaluate()
            obj.result = "fail" if obj.failure_reasons else "pass"
            obj.created_at = min(obj.started_at + timedelta(hours=1), self.now)
            rows.append(obj)
            cyc["obj"] = obj
        SterilizationCycle.objects.bulk_create(rows, batch_size=500)
        load_rows = []
        for cyc in cycle_objs:
            for e in cyc["loads"]:
                a = e["used"]
                ld = PackLoad(clinic=c, cycle=cyc["obj"], pack=e["pack"], expires_on=e["expires_on"])
                if a is not None:
                    ld.used_at, ld.appointment, ld.patient = a.start + timedelta(minutes=5), a, a.patient
                    ld.used_by = a.dentist.user if a.dentist.user_id else None
                ld.created_at = cyc["obj"].created_at
                load_rows.append(ld)
        PackLoad.objects.bulk_create(load_rows, batch_size=1000)
        # The failed cycle's autoclave was serviced the day the result came in.
        failed = SterilizationCycle.objects.filter(clinic=c, result="fail").first()
        if failed:
            # Reception has called about half of the patients on the recall list.
            notes = ["Called, no symptoms; booked a check-up.", "Called and explained; follow-up blood test advised by Dr Karim.", "WhatsApp sent, patient called back."]
            for i, ld in enumerate(services.suspect_loads(failed).filter(patient__isnull=False).order_by("used_at", "id")):
                if i % 2 == 0:
                    ld.recall_contacted_at = failed.bi_read_at + timedelta(hours=self.r.randint(2, 30))
                    ld.recall_note = self.r.choice(notes)
                    ld.save(update_fields=["recall_contacted_at", "recall_note"])
        if failed:
            order = services.open_work_order(c, self.eq["ac-b"], issue="Positive biological indicator on the Sunday test load. Check door seal, vacuum pump and temperature sensor.",
                                             user=s.user.get("aya"), priority="urgent", takes_out_of_service=True, assigned_to="Cairo Dental Supplies service team",
                                             reported_at=failed.bi_read_at)
            gasket = self.spare("SP-GSK", "Autoclave door gasket", "جوان باب الأوتوكلاف", 1450, 3)
            services.add_part(order, gasket, s.branch["nasr"], 1)
            services.close_work_order(order, resolution="Door gasket replaced, chamber sensor recalibrated, three empty cycles and a new BI passed.",
                                      labour_cost=Decimal("1200"), when=failed.bi_read_at + timedelta(hours=26))
        # Daily surface and waterline checklist for the last month.
        for back in range(30, -1, -1):
            d = self.today - timedelta(days=back)
            if d.weekday() == FRIDAY:
                continue
            for code in ("nasr", "helio"):
                if back == 0 and code == "helio":
                    continue  # today's Heliopolis list is still to be done
                items = {k: True for k in DailyChecklist.ITEMS}
                if self.r.random() < 0.12:
                    items[self.r.choice(DailyChecklist.ITEMS)] = False
                DailyChecklist.objects.create(clinic=c, branch=s.branch[code], date=d, items=items, done_by=operators[code],
                                              notes="Waterline shock treatment done." if d.weekday() == 0 and code == "nasr" else "")

    def needs_cycle(self, entry, day):
        if entry is None or entry["used"] is not None or entry["expires_on"] < day:
            return True
        cyc = entry["cycle"]  # packs left from a cycle whose indicator grew are sterilised again
        return cyc.get("bi_result") == "positive" and timezone.localtime(cyc["bi_read_at"]).date() <= day

    def use_for_visit(self, a, packs, state):
        code = a.procedure.code if a.procedure_id else ""
        kinds = ["cassette"]
        if code[:2] in ("RS", "EN", "PR", "CO"):
            kinds.append("handpiece")
        if code[:2] == "EN":
            kinds.append("tray")
        if code[:2] == "OS":
            kinds.append("surgical")
        if code[:2] == "IM":
            kinds.append("implant")
        day = timezone.localtime(a.start).date()
        for kind in kinds:
            # First in, first out: the pack sterilised longest ago is opened first.
            ready = [state[p.pk] for p in packs if p.kind == kind and state[p.pk] is not None and state[p.pk]["used"] is None
                     and state[p.pk]["cycle"]["started_at"] < a.start and state[p.pk]["expires_on"] >= day and not self.needs_cycle(state[p.pk], day)]
            if ready:
                min(ready, key=lambda e: e["cycle"]["started_at"])["used"] = a

    def spare(self, code, en, ar, cost, qty):
        item = StockItem.objects.filter(clinic=self.c, code=code).first()
        if item is None:
            item = StockItem.objects.create(clinic=self.c, code=code, name_en=en, name_ar=ar, category="other", unit="piece", last_cost=Decimal(cost),
                                            reorder_level=1, reorder_quantity=2, notes="Spare part for equipment")
            lot = stock.lot_for(self.c, item, self.s.branch["nasr"])
            stock.move(lot, "receive", qty, unit_cost=Decimal(cost), note="Opening stock of spare parts")
        return item

    # ------------------------------------------------------------ maintenance
    def plan(self, key, en, ar, kind, last_days_ago, vendor, cost, months=None, days=None, cycles=None, history=True):
        e = self.eq[key]
        p = MaintenancePlan.objects.create(clinic=self.c, equipment=e, title_en=en, title_ar=ar, kind=kind, every_months=months, every_days=days,
                                           every_cycles=cycles, start_on=self.today - timedelta(days=500), vendor=vendor)
        if last_days_ago is not None:
            done = self.today - timedelta(days=last_days_ago)
            if history:
                interval = (months or 0) * 30 + (days or 0) or 180
                earlier = done - timedelta(days=interval)
                if earlier >= self.start:
                    MaintenanceRecord.objects.create(clinic=self.c, equipment=e, plan=p, done_on=earlier, performed_by=vendor, cost=Decimal(cost))
            counts = services.cycle_counts(self.c, [e.pk]) if cycles else {}
            at_cycles = None
            if cycles:
                after = SterilizationCycle.objects.filter(machine=e, started_at__date__gt=done).count()
                at_cycles = counts.get(e.pk, 0) - after
            MaintenanceRecord.objects.create(clinic=self.c, equipment=e, plan=p, done_on=done, performed_by=vendor, cost=Decimal(cost), cycle_count=at_cycles)
            p.last_done_on, p.last_done_cycles = done, at_cycles
            p.save()
        return p

    def maintenance(self):
        s, r, c = self.s, self.r, self.c
        self.plan("ac-a", "Annual service and validation", "صيانة سنوية ومعايرة", "service", 120, "W&H agent (Cairo Dental Supplies)", 3500, months=6, cycles=1000)
        self.plan("ac-b", "Service: gasket, filters, sensor check", "صيانة: جوان وفلاتر وحساسات", "service", 17, "Cairo Dental Supplies", 2800, months=6, cycles=1000, history=False)
        self.plan("ac-h", "Service and validation", "صيانة ومعايرة", "service", 168, "Nile Dental Trading", 3000, months=6, cycles=800)
        for code in ("nasr", "helio"):
            # Heliopolis compressor is overdue: oil change was due a month ago.
            self.plan(f"comp-{code}", "Oil change, drain and air filters", "تغيير الزيت وفلاتر الهواء", "filter", 50 if code == "nasr" else 122,
                      "El Nasr Medical Store", 900, months=3)
            # Nasr City suction filter is overdue too.
            self.plan(f"suction-{code}", "Amalgam separator and suction filters", "فلتر الشفاط وفاصل الأملغم", "filter", 41 if code == "nasr" else 12,
                      "In-house (assistant)", 350, days=30)
            self.plan(f"xray-{code}", "X-ray quality assurance test", "اختبار جودة جهاز الأشعة", "inspection", 210 if code == "nasr" else 90,
                      "Atomic Energy Authority accredited physicist", 1800, months=12)
        for chair in s.chairs["nasr"] + s.chairs["helio"]:
            self.plan(f"chair-{chair.pk}", "Dental unit service: hoses, valves, waterlines", "صيانة الوحدة: الخراطيم والصمامات وخطوط المياه", "service",
                      r.randint(20, 160), "Sirona agent" if chair.branch == s.branch["nasr"] else "Fedesa agent", 1500, months=6)
        self.plan("cbct", "CBCT calibration", "معايرة جهاز الأشعة المقطعية", "calibration", 300, "Carestream Egypt", 6500, months=12)
        self.plan("opg", "OPG calibration", "معايرة جهاز البانوراما", "calibration", 160, "Vatech agent", 4500, months=12)
        self.plan("scan-nasr", "Scanner calibration", "معايرة الماسح الضوئي", "calibration", 70, "In-house", 0, months=3)
        self.plan("mill", "Spindle service and bur change", "صيانة السبندل وتغيير البرايم", "service", 85, "Amann Girrbach agent", 5200, months=6)
        self.plan("furnace", "Furnace temperature calibration", "معايرة حرارة الفرن", "calibration", 175, "Ivoclar agent", 2500, months=6)
        self.plan("printer", "Resin tank and optics clean", "تنظيف خزان الريزن والعدسات", "service", 25, "In-house (lab)", 0, months=1)

        # Breakdowns: a few finished over the months, three still open.
        filt = self.spare("SP-CFL", "Compressor air filter", "فلتر هواء الكمبروسر", 320, 6)
        hose = self.spare("SP-HOS", "Handpiece hose (4-hole)", "خرطوم الهاند بيس", 850, 3)
        lamp = self.spare("SP-LED", "Dental unit LED light module", "لمبة الوحدة LED", 2100, 2)
        nasr = s.branch["nasr"]
        chairs = s.chairs["nasr"]
        closed = [
            (f"chair-{chairs[1].pk}", 150, "Water leaking from the turbine hose.", "high", True, "Sirona agent", [(hose, 1)], 400, "Hose replaced.", 5),
            ("comp-nasr", 110, "Compressor runs non-stop and pressure drops in the afternoon.", "urgent", False, "El Nasr Medical Store", [(filt, 2)], 600, "Air filters and a cracked pipe replaced.", 26),
            (f"chair-{chairs[0].pk}", 62, "Operating light flickering.", "normal", False, "Sirona agent", [(lamp, 1)], 300, "LED module replaced.", 50),
            ("printer", 33, "Prints failing: layers separating.", "normal", False, "In-house (lab)", [], 0, "Resin tank film replaced, printer recalibrated.", 4),
            ("xray-helio", 18, "Exposure button does not respond intermittently.", "high", True, "Planmeca agent", [], 950, "Hand switch cable replaced.", 30),
        ]
        reporter = [s.user.get(u) for u in ("aya", "omar", "karim", "hesham", "salma")]
        for i, (key, ago, issue, prio, down, who, parts, labour, fix, hours) in enumerate(closed):
            when = timezone.make_aware(datetime.combine(self.today - timedelta(days=ago), time(11 + i, 15)))
            order = services.open_work_order(c, self.eq[key], issue=issue, user=reporter[i % len(reporter)], priority=prio, takes_out_of_service=down,
                                             assigned_to=who, reported_at=when)
            for item, qty in parts:
                services.add_part(order, item, nasr, qty)
            services.close_work_order(order, resolution=fix, labour_cost=Decimal(labour), when=when + timedelta(hours=hours))
        o1 = services.open_work_order(c, self.eq["scan-helio"], issue="Scanner tip cracked; scanner will not calibrate.", user=s.user.get("youssef"),
                                      priority="high", takes_out_of_service=True, assigned_to="Medit Egypt", reported_at=self.now - timedelta(days=4, hours=3))
        o1.status = "waiting_parts"
        o1.save()
        o2 = services.open_work_order(c, self.eq["mill"], issue="Spindle noise during zirconia milling; stopped mid-job twice.", user=s.user.get("hesham"),
                                      priority="urgent", assigned_to="Amann Girrbach agent", reported_at=self.now - timedelta(days=1, hours=5))
        o2.status = "in_progress"
        o2.save()
        services.open_work_order(c, self.eq["suction-helio"], issue="Weak suction on chair 2 in the evenings.", user=s.user.get("omar"),
                                 priority="normal", reported_at=self.now - timedelta(hours=6))

    def licences(self):
        s, c = self.s, self.c
        t = self.today
        rows = [
            ("xray_licence", "X-ray room licence (Nasr City)", "ترخيص غرفة الأشعة (مدينة نصر)", "nasr", "xray-nasr", None, "EAEA-RL-2024-11873", "Egyptian Atomic Energy Authority", t - timedelta(days=340), t + timedelta(days=26)),
            ("xray_licence", "X-ray room licence (Heliopolis)", "ترخيص غرفة الأشعة (مصر الجديدة)", "helio", "xray-helio", None, "EAEA-RL-2025-04519", "Egyptian Atomic Energy Authority", t - timedelta(days=120), t + timedelta(days=245)),
            ("xray_licence", "CBCT and OPG room licence", "ترخيص غرفة الأشعة المقطعية والبانوراما", "nasr", "cbct", None, "EAEA-RL-2025-07702", "Egyptian Atomic Energy Authority", t - timedelta(days=200), t + timedelta(days=530)),
            ("radiation_officer", "Radiation safety officer: Dr Karim", "مسؤول الوقاية الإشعاعية: د. كريم", "nasr", None, "karim", "RSO-5521", "Egyptian Atomic Energy Authority", t - timedelta(days=400), t + timedelta(days=330)),
            ("pressure_vessel", "Pressure vessel test: compressor (Nasr City)", "اختبار وعاء الضغط: كمبروسر مدينة نصر", "nasr", "comp-nasr", None, "PV-88213", "Civil Defence", t - timedelta(days=320), t + timedelta(days=45)),
            ("medical_waste", "Medical waste collection contract", "عقد جمع النفايات الطبية", None, None, None, "MW-2026-118", "Cairo Cleaning and Beautification Authority", t - timedelta(days=150), t + timedelta(days=215)),
            ("clinic_licence", "Clinic licence (Nasr City)", "ترخيص العيادة (مدينة نصر)", "nasr", None, None, "MOH-CL-77812", "Ministry of Health", t - timedelta(days=700), t + timedelta(days=395)),
            ("clinic_licence", "Clinic licence (Heliopolis)", "ترخيص العيادة (مصر الجديدة)", "helio", None, None, "MOH-CL-80455", "Ministry of Health", t - timedelta(days=560), t + timedelta(days=535)),
            ("fire_safety", "Fire safety certificate", "شهادة الحماية المدنية", None, None, None, "CD-FS-6610", "Civil Defence", t - timedelta(days=260), t + timedelta(days=105)),
        ]
        for kind, en, ar, branch, eq, staff, ref, auth, issued, expires in rows:
            Licence.objects.create(clinic=c, kind=kind, title_en=en, title_ar=ar, branch=s.branch[branch] if branch else None,
                                   equipment=self.eq.get(eq) if eq else None, staff=s.staff.get(staff) if staff else None, reference=ref,
                                   authority=auth, issued_on=issued, expires_on=expires)
        # Dosimeter badges are exchanged every three months; one is a week late.
        for i, u in enumerate(("karim", "salma", "youssef", "aya", "omar")):
            member = s.staff.get(u)
            if member is None:
                continue
            Licence.objects.create(clinic=c, kind="dosimeter", title_en=f"Dosimeter badge: {member.name_en}", title_ar=f"بادج قياس الجرعة: {member.name_ar}",
                                   staff=member, branch=member.branches.first(), reference=f"TLD-{4410 + i}", authority="National Centre for Radiation Research",
                                   issued_on=t - timedelta(days=97 if i == 3 else 20 - i * 4), expires_on=t + timedelta(days=-7 if i == 3 else 70 + i * 4),
                                   last_reading_msv=Decimal(str(round(0.05 + 0.03 * i, 3))))

    # ------------------------------------------------------------ e-invoicing
    def einvoices(self):
        s, c, r = self.s, self.c, self.r
        conf = EInvoiceSettings.for_clinic(c)
        for k, v in dict(is_registered=True, mode="simulation", environment="preprod", rin=RIN, issuer_name="عيادة عكاشة لطب الأسنان",
                         activity_code="8623", governate="Cairo", region_city="Nasr City", street="Abbas El Akkad St.", building_number="12",
                         postal_code="11765", start_date=self.start.replace(day=1), default_item_code=f"EG-{RIN}-OTHER").items():
            setattr(conf, k, v)
        conf.save()
        EtaBranchAddress.objects.create(clinic=c, branch=s.branch["nasr"], branch_code="0", governate="Cairo", region_city="Nasr City", street="Abbas El Akkad St.", building_number="12", postal_code="11765")
        EtaBranchAddress.objects.create(clinic=c, branch=s.branch["helio"], branch_code="1", governate="Cairo", region_city="Heliopolis", street="El Merghany St.", building_number="45", postal_code="11341")
        for p in Procedure.objects.filter(clinic=c):
            # One code was registered with a typo in the RIN: the Tax Authority refuses it.
            rin = "512345687" if p.code == "OS03" else RIN
            EtaItemCode.objects.create(clinic=c, procedure=p, item_type="EGS", item_code=f"EG-{rin}-{p.code}")
        # Two patients' national IDs were typed wrong (a 13th month).
        invoices = list(Invoice.objects.filter(clinic=c, status="issued", issue_date__gte=conf.start_date).select_related("patient").order_by("issue_date", "id"))
        per_patient = defaultdict(int)
        for i in invoices:
            per_patient[i.patient_id] += 1
        older = [i for i in invoices if i.issue_date < self.today - timedelta(days=30) and i.patient.national_id and per_patient[i.patient_id] == 1]
        for inv in r.sample(older, min(2, len(older))):
            p = inv.patient
            p.national_id = p.national_id[:3] + "13" + p.national_id[5:]
            p.save(update_fields=["national_id", "search_text", "updated_at"])
        while services.prepare_missing(c, conf):
            pass
        cutoff = self.today - timedelta(days=2)
        docs = list(EInvoiceDocument.objects.filter(clinic=c, status="ready", invoice__issue_date__lt=cutoff).select_related("invoice").order_by("invoice__issue_date"))
        for i in range(0, len(docs), 100):
            services.submit(docs[i:i + 100], conf)
        # Backdate: each invoice was sent the evening it was issued and validated within minutes.
        for d in EInvoiceDocument.objects.filter(clinic=c).select_related("invoice"):
            issued = timezone.make_aware(datetime.combine(d.invoice.issue_date, time(20, r.randint(5, 55))))
            fields = {"prepared_at": min(issued - timedelta(hours=1), self.now)}
            if d.submitted_at:
                fields["submitted_at"] = min(issued, self.now)
                fields["validated_at"] = min(issued + timedelta(minutes=r.randint(2, 15)), self.now)
            EInvoiceDocument.objects.filter(pk=d.pk).update(**fields)

    # ------------------------------------------------------------ booking
    def booking(self):
        s, c, r = self.s, self.c, self.r
        conf = BookingSettings.for_clinic(c)
        conf.enabled = True
        conf.slug = "okasha-dental"
        conf.days_ahead = 30
        conf.min_notice_hours = 3
        conf.slot_minutes = 30
        conf.message_en = "Choose a time and we will call you to confirm within working hours. For pain or swelling, call us directly."
        conf.message_ar = "اختار الميعاد المناسب وهنكلمك نأكد الحجز في مواعيد العمل. لو عندك ألم أو ورم كلمنا على طول."
        conf.save()
        codes = ["DX01", "PV01", "RS01", "OS01", "CO01", "OR01", "EN03", "IM01"]
        conf.services.set(Procedure.objects.filter(clinic=c, code__in=codes))
        procs = {p.code: p for p in conf.services.all()}
        people = [("ليلى حسن", "+201223334455", "ar", "PV01", "تنظيف قبل السفر لو ينفع"), ("Omar Fathy", "+201005556677", "en", "DX01", "Pain in the lower left side"),
                  ("منة الله سامي", "+201117778899", "ar", "CO01", "عايزة أعرف السعر"), ("كريم عبد الرحمن", "+201550001122", "ar", "OS01", ""),
                  ("Nour Adel", "+201016667788", "en", "OR01", "For my daughter, 12 years old"), ("هالة منصور", "+201278889900", "ar", "RS01", "")]
        # The one already confirmed is a patient the clinic knows: reception matched the phone number.
        known = Patient.objects.filter(clinic=c, is_active=True).exclude(phone="").order_by("file_number").first()
        if known is not None:
            people[-1] = (known.name_ar or known.name_en, known.phone, known.language or "ar", "RS01", "")
        made = []
        # Five waiting for reception, one already confirmed for later this week.
        for i, (name, phone, lang, code, note) in enumerate(people):
            branch = s.branch["nasr" if i % 3 else "helio"]
            proc = procs.get(code)
            day = self.today + timedelta(days=1 + i % 5)
            if day.weekday() == FRIDAY:
                day += timedelta(days=1)
            slots = services.free_slots(conf, branch, day, services.service_minutes(conf, proc), None, self.now)
            if not slots:
                continue
            start, free = slots[min(len(slots) - 1, 3 + i * 2)]
            req = BookingRequest.objects.create(
                clinic=c, reference=f"{r.randint(0x100000, 0xFFFFFF):06X}", branch=branch, procedure=proc, dentist_id=free[0], start=start,
                duration_minutes=services.service_minutes(conf, proc), name=name, phone=phone, note=note, language=lang, consent=True,
                ip_address=f"197.{r.randint(32, 63)}.{r.randint(0, 255)}.{r.randint(1, 254)}", user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)",
            )
            BookingRequest.objects.filter(pk=req.pk).update(created_at=self.now - timedelta(hours=2 + i * 7))
            made.append(req)
        mine = [m for m in made if known is not None and m.phone == known.phone]
        if mine:
            services.confirm_request(mine[0], user=s.user.get("mariam"))
        # Earlier requests: confirmed into visits that took place, a declined one and an expired one.
        past = list(Appointment.objects.filter(clinic=c, status="completed", start__date__gte=self.today - timedelta(days=50), start__date__lt=self.today)
                    .select_related("patient", "branch", "procedure").order_by("start"))
        for a in r.sample(past, min(7, len(past))):
            created = a.start - timedelta(days=r.randint(1, 4), hours=r.randint(1, 8))
            req = BookingRequest.objects.create(
                clinic=c, reference=f"{r.randint(0x100000, 0xFFFFFF):06X}", branch=a.branch, procedure=a.procedure if a.procedure in procs.values() else None,
                dentist=a.dentist, start=a.start, duration_minutes=a.duration_minutes, name=a.patient.name_ar or a.patient.name_en, phone=a.patient.phone,
                language=a.patient.language, consent=True, status="confirmed", patient=a.patient, appointment=a, decided_by=s.receptionist[s.branch_code[a.branch_id]],
                decided_at=created + timedelta(hours=1, minutes=20),
            )
            BookingRequest.objects.filter(pk=req.pk).update(created_at=created)
        branch = s.branch["nasr"]
        for status, days, name, phone, reason in (("rejected", 9, "Test test", "+201000000001", "Duplicate of a phone booking."),
                                                  ("expired", 3, "أحمد سمير", "+201234567890", "")):
            start = aware(self.today - timedelta(days=days), 18)
            req = BookingRequest.objects.create(clinic=c, reference=f"{r.randint(0x100000, 0xFFFFFF):06X}", branch=branch, procedure=procs.get("DX01"),
                                                start=start, duration_minutes=30, name=name, phone=phone, consent=True, status=status, reject_reason=reason,
                                                decided_by=s.user.get("mariam") if status == "rejected" else None,
                                                decided_at=start - timedelta(days=1) if status == "rejected" else None)
            BookingRequest.objects.filter(pk=req.pk).update(created_at=start - timedelta(days=2))


def seed(seeder):
    ComplianceDemo(seeder).run()
