# Conference Manager

[Admin guide](README.md) › Conference Manager

The Conference Manager plugin (version 2.31.1) runs conference registrations: inscriptions, fee payments,
lodging, transport, meals and badges. This page covers the admin screens that changed most recently. What the
plugin does as a whole, and its permissions, are in the [plugins reference](../plugins-reference.md).

Install and activate it from [Plugins](plugins.md). It then adds **Conference** to the sidebar: the **Conference
List** shows your conferences; **Manage** opens one. Its screens are tabs: **Dashboard**,
**Inscriptions**, **Fee payments**, **Accounting**, **Lodging**, **Transport**, **Meals**, **Badges**,
**Locations**, **Assignment**, **Fields**, **Pricing**, **Reports** and **Team & permissions**.

The plugin's screens follow the admin language (Spanish, English or Portuguese); a few labels are Spanish in every
language, and are given here as shown.

## Who sees what

**Team & permissions** («Equipo y permisos», administrators only) gives each team role a level per section: **No
access**, **View** or **Manage** («Sin acceso», «Ver», «Gestionar»), and **Operate** («Operar») for meal delivery.
A tab appears only to those who can view it, and someone who can only view sees **Read only: your role lets you
view this section, but not change it.** WordJS administrators can do everything.

## Dialogs and form errors

Every confirmation opens inside the admin, in your language. Forms check their own fields: a missing or wrong
value is explained under the field (**This field is required.**, **Enter a number.**, **The minimum is N.**,
**Enter a valid email address.**…) and the cursor moves to the first field to fix.

## The «Needs lodging» field

A conference's registration form can ask whether each person needs a room.

1. Open the conference's **Fields** tab («Campos»), the **Visual Form Builder**.
2. Press **Add Field** («Nuevo Campo»). The dialog (titled «Nuevo Campo» in every language) starts with **Basic
   fields** («Campos básicos»): ready-made fields that lodging, meals, exports and the portal understand.
3. Click **Needs lodging** («Requiere hospedaje»). It is added at once (**Field «Needs lodging» added**); afterwards
   its card reads **Already in the form as «…»**.

Fields can be added only while the form is not published.

The field is a Yes / No switch (it shows «Sí» / «No»), and its type cannot be changed. Whoever answers **No**:

- is left out of the automatic room assignment;
- cannot be given a room by hand: the assign dialog shows **Needs no lodging: cannot be given a room**;
- appears in lists as **No lodging needed** instead of without a room;
- frees their bed if they had one when the answer changes to No.

An empty answer counts as needing lodging, so conferences without this field work as before. Deleting the field
warns that everyone will need a room again, and clears the answers.

## Fee payments

**Fee payments** («Pagos de cuotas») records what people pay. **Each payment is one receipt split among the people
it covers.** (Transport is paid in **Transport**.) Viewing needs **Payments › View**; recording, validating and
correcting need **Payments › Manage**.

The buttons at the top: **Record payment** («Registrar pago»), **Excel** and **Accounting**. Four sections:

- **Summary** («Resumen»): totals for **Fees**, **Validated**, **To validate**, **Sent back** and **To collect**,
  and the same **By location**.
- **To validate** («Por validar»): the queue, oldest first. Open a payment to **Validate** it (or **Validate and
  next**).
- **Payments** («Pagos»): every payment, with filters by status, method, who recorded it, dates and a search.
- **Balances** («Saldos»): what each person owes. Tick people (or **Select this page**) and press **Record payment (N)**
  to pay for all of them at once.

### Recording a payment

**Record payment** opens a form with:

1. **People** («Personas»): **Add** opens a search; each person shows what they still owe. Up to 200 per payment.
2. **Payment** («Pago»): **Total amount** (filled in with what they owe; **Use what is left** puts it back),
   **Payment method** (Efectivo or Transferencia), **Payment date** (today by default; it cannot be in the future),
   the **Transfer reference** or **Reference (optional)**, and **+ Add note**.
3. **Split** («Reparto»): **Equal** shares, or **Manual** amounts per person; the line below says whether it
   **Adds up**.
4. **Receipt** («Comprobante»): **Take a photo or choose a file**. Required for a transfer.
5. **Leave for validation** («Dejar por validar»): unticked, the payment is validated as you record it.

The main button shows the amount and stays disabled until the form is complete; the first thing missing is
spelled out above it. A reference already used in another payment asks before going on.

### Validating, sending back and rejecting

A payment's detail shows its receipt, its split and its history. Depending on its state it offers **Validate**,
**Send back…** (to whoever recorded it, to correct it), **Reject…**, **Edit split** and **Delete**. Sending back
and rejecting ask for the reason in the panel itself, with quick reasons such as «Comprobante ilegible». A
validated payment can only be voided (**Void validation…**), not edited or deleted.

## Meals

**Meals** («Alimentación») is titled **Meals and deliveries**: choose which meals each location gets, adjust per
person, and record every delivery with the attendee's QR code. It has four tabs:

- **Plan**: the **Meal services** («Servicios de comida»), each one meal on one day. **Create services** makes
  several at once from a range of dates and the meals (**Breakfast**, **Lunch**, **Dinner**) for the locations you
  pick. Below, **What each location gets** is a grid of locations and services.
- **Per person** («Por persona»): find someone and set each service to **Inherit**, **Include** or **Exclude**.
- **Delivery** («Entrega»), for the kitchen: pick the **Service**, then scan each attendee's code with a scanner
  or type it and press Enter. With **Confirm before delivering** on (the default on each device), a card shows the
  person and waits for **Enter** to deliver or **Esc** to cancel. **Use the camera** and **Scanner mode (phone)**
  read the QR with a camera.
- **Report** («Reporte»): per service, who was entitled and who received it, with an **Excel** export.

## Badges

**Badges** («Escarapelas») designs each attendee's credential: they see it in «Mi inscripción», and it prints as an
ID-card PDF with the QR the meal scanner reads. There is one design per conference, and coordinators see the badges
only after you press **Save design** («Guardar diseño»).

- **Design** («Diseño»): a free-form designer with **Templates**, **Text**, **Shapes**, **Images** and **Background**.
  Applying a template over your design asks first (**Change template**), and **Undo** brings it back. The QR cannot
  be removed: it is what the meal scanner reads.
- **People** («Personas»): each attendee's badge link, to open, copy or send by WhatsApp. **All at once** copies
  every link, exports them to Excel, or makes a PDF to print (on Letter sheets, or one per page).
- **Settings** («Ajustes»): **Badges on**, **Coordinators may share them**, **Links expire on**, the country code for
  WhatsApp, and whether the QR opens «Mi inscripción».

On one person's badge, **New link** and **Revoke link** each ask before the old link stops working.
