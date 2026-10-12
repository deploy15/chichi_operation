# ChiChi Operations

One web app to run the company's workforce and site operations:
clients, projects, sites, workers, daily attendance (also without Internet),
catering and kitchens, accommodation, medical follow-up, HSE incidents, payroll figures and costs.

- **Website (frontend):** React. Works on computers, tablets and phones, and can be installed on a phone like an app.
- **Server (backend):** Node.js.
- **Database:** MySQL.

The website and server are one project: the server also delivers the website, so there is only one thing to host.

---

## 1. Putting it on Heroku

You need a free Heroku account and the Heroku command-line tool (https://devcenter.heroku.com/articles/heroku-cli).

```bash
# 1. In this folder, create the app (pick your own name)
heroku login
git init && git add . && git commit -m "First version"
heroku create chichi-operations

# 2. Add a MySQL database. This automatically gives the app its database address (JAWSDB_URL).
heroku addons:create jawsdb:kitefin        # free trial size; choose a paid plan for real use (see section 5)

# 3. Settings the app needs
heroku config:set NODE_ENV=production
heroku config:set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
heroku config:set ADMIN_EMAIL=you@yourcompany.com ADMIN_PASSWORD='Choose-A-Strong-Password' COMPANY_NAME='Your Company'

# 4. Send the code to Heroku
git push heroku main        # (use "master" if that is your branch name)

# 5. Open it
heroku open
```

What happens on every push: Heroku installs everything, builds the website, then
**creates or updates the database tables automatically** (the `release` line in `Procfile`).
The first time, it also creates the administrator account from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
Sign in with that, then change the password under your name (top right).

**Optional – sample data to try things out** (only works on an empty database):

```bash
heroku run npm run seed:demo
```
It adds the example from the requirements (Client A with Projects X and Y, Client B with Project Z, Sites 1–7),
a central kitchen and a temporary kitchen, 42 workers, 10 days of attendance and sample users for every role
(all with password `Demo1234!`): `md@demo.local`, `daf@demo.local`, `recruitment@demo.local`, `site1@demo.local`,
`chef@demo.local`, `souschef@demo.local`, `transport@demo.local`, `medical@demo.local`, `housing@demo.local`, `hse@demo.local`.
Do not run it on the real database.

### Settings (Config Vars)

| Name | What it is |
|---|---|
| `JAWSDB_URL` | Database address. Set automatically by the JawsDB add-on. (`DATABASE_URL` or `CLEARDB_DATABASE_URL` also work.) |
| `JWT_SECRET` | Long random text used to protect sign-ins. Required. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | First administrator, created only if there are no users yet. |
| `COMPANY_NAME` | Your company's name. |
| `NODE_ENV` | Set to `production` (forces secure https). |
| `JWT_EXPIRES_IN` | Optional. How long a sign-in lasts, default `12h`. |
| `DB_SSL` | Optional. `true` to encrypt the database connection if your MySQL provider supports it. |

---

## 2. Running it on your own computer

You need Node.js 22 and MySQL 8.

```bash
# Create an empty database
mysql -u root -p -e "CREATE DATABASE chichi; CREATE USER 'chichi'@'localhost' IDENTIFIED BY 'chichi'; GRANT ALL ON chichi.* TO 'chichi'@'localhost';"

cp .env.example .env          # then edit .env if needed
npm install
npm run migrate               # creates the tables and the first administrator
npm run seed:demo             # optional sample data
npm run build                 # builds the website
npm start                     # open http://localhost:4000
```

While changing the website, run `npm run dev` (server) and, in a second window, `cd client && npm run dev`
(website with instant reload at http://localhost:5173).

**Checks:** `npm test` runs 19 automatic checks of the main rules (what each role can and cannot do, offline sync,
meal calculation, the delivery steps, approvals, cost sharing and more). Run it on a fresh database right after `npm run seed:demo`, since it changes the data.

---

## 3. How the main rules work

**Structure.** Company → Clients → Projects → Sites → Workers. A worker is placed on a site through an
*assignment* with start and end dates. To move a worker you add a new assignment; the old one is closed
automatically and **kept forever as history**. Two assignments for the same worker can never overlap.

**Attendance.** Site Administrators mark each worker Present or Absent, with late arrival, early departure, normal hours,
overtime and a comment. Each record is tied to worker + project + site + date + assignment. A Site Administrator
only sees the sites given to them (set under *Users & Settings → Users*). Every day they press
*Submit daily workforce report*. The system records whether it came before the deadline (09:00 by default) and shows
every site's report under *Attendance → Daily workforce reports*. Meals and payroll only use submitted attendance.

**Working without Internet.**
- The app stores itself on the device, so it opens even with no connection.
- The list of workers for the manager's sites is saved on the device whenever they are online.
- Every change gets its own unique ID and is first saved on the device (in the browser's built-in database).
- When the connection returns, changes are sent automatically (also every 30 seconds, and with a "Send now" button).
  If sending fails it tries again, waiting a little longer each time.
- The server remembers every change ID it has received, so the same change is **never saved twice**.
- If someone else changed the same record in the meantime, the server does **not** overwrite it. It saves a
  *conflict* that the Site Administrator resolves under *Attendance → Offline conflicts*. The server is always the official copy.
- Every change to an attendance record is kept in its history.

**Meals.** Meals needed = worker present (in a submitted daily report) + valid assignment + that meal included in the assignment.
Step by step:
1. The Catering Director presses *Calculate meals needed*, then *Create production plans* (one per kitchen and meal),
   and sets the quantity and menu for each plan.
2. Sous-chefs record meals cooked and portioned.
3. The Catering Director checks quality and hygiene of each batch. Only approved meals can be sent.
4. The Catering Director plans each delivery (site, quantity, departure time, vehicle) and validates the quantity.
5. The transport team records what was loaded, then confirms delivery.
6. The Site Administrator records the dishes received and how many meals were handed out, and can report a delay or complaint.
   The Catering Director sees these under *Site feedback* and replies.

*Meal tracking* shows Needed → Produced → Dispatched → Received → Handed out → Remaining. The system will not let anyone
send or hand out more meals than are actually available.

Sous-chefs and the dishwashing, sealing and transport team also keep a daily log (preparation, handovers, shortages,
cleaning, damaged equipment, packaging, labels, delays, losses) under *Catering & Kitchen → Kitchen & transport log*.

**Kitchens.** Central or temporary; active, suspended or closed. A temporary kitchen must have a start date,
planned closing date, project and location, and has its own stock, staff, production and expenses.
Each site is assigned to a kitchen for a period; changing it keeps the old period as history.

**Stock and purchases.** Only the Catering Director changes stock (use, losses, deliveries). Sous-chefs and the
transport team can see their kitchen's stock and report a shortage or loss. When something must be bought, the
Catering Director submits a *purchase request*; the DAF approves it. Requests above the major-expense limit
(1,000,000 by default) can only be approved by the Managing Director. Nobody can approve their own request.

**Costs.** The DAF records invoices, purchase orders and delivery notes and validates them (amounts above the
major-expense limit need the Managing Director). Changing a validated expense sends it back for validation.
The DAF also sets budgets for a client, project or kitchen; the system shows how much of each budget has been spent.
Expenses (food, suppliers, transport, fuel, staff, energy, equipment, other) are shared out to
Client → Project → Site by: direct (one site), meal count (in proportion to the meals each site needed that month from
that kitchen), percentage, or manual amounts. The parts always add up exactly to the expense.

**Payroll figures.** From attendance: hourly workers get hours × rate; daily workers get days present × rate,
plus the worker's daily allowance for each day present.
Overtime = overtime hours × hourly rate × overtime multiplier (default 1.5; for daily workers the hourly rate is the daily
rate ÷ 8). Both numbers can be changed by the DAF under *Users & Settings → Settings*. Results can be downloaded as a spreadsheet.

**Accommodation.** Facilities → buildings → rooms with a number of beds. Check-in refuses full or closed rooms and
workers already checked in elsewhere. Shows total beds → occupied → available, and full history.

**Medical.** Only roles with medical permissions can open it (not even HR). Every time a medical record or file is
opened, it is written to the audit log.

**HSE.** Site Administrators report incidents for their own sites; client and project are filled in from the site.
Photos/documents can be attached. The HSE manager adds corrective actions with a responsible person and due date,
and has a dashboard (open/closed, by site, by project, severity, overdue actions, trend over 12 months).
When an action is done, the Managing Director approves it.

**Recruitment and staffing.** The Recruitment Manager creates job profiles and registers candidates. The candidate's
ID and qualifications are checked (by the Recruitment Manager or the DAF), then the Recruitment Manager approves the
selection and turns the candidate into a worker with one click. When a client asks a site for more workers, the Site
Administrator records the request and forwards it; the Recruitment Manager fills it by assigning workers. To replace an
absent or sick worker, the Recruitment Manager adds an assignment and picks who is being replaced; that worker is marked
absent. Each worker shows a deployment status: available, deployed, absent or unassigned.

**Roles.** These follow the *System privileges by role* document:

| Role | Can do | Cannot do |
|---|---|---|
| Managing Director (MD / DG) | Everything, including major purchases and expenses, approving HSE corrective actions, users, roles and settings | — |
| Finance & Administration Director (DAF) | Budgets, payroll (rates, allowances, overtime rule), recording and validating invoices / purchase orders / delivery notes, contracts, CNSS and insurance on worker files, checking candidate documents, approving purchase requests. Sees workers, attendance, catering and stock | Assign or replace workers, edit attendance, change catering production, menus or quantities |
| Recruitment Manager (RRJ / HR Casual Workers) | Job profiles, candidates, approving selection, worker files, assigning and replacing workers, deployment status, handling staffing requests. Sees attendance | Change pay or finance, edit attendance, catering or meal quantities, approve purchases |
| Site Administrator (own sites only) | Attendance, daily workforce report, incidents, client staffing requests, dishes received, meals handed out, delay and complaint reports | Assign or replace workers, payroll, production, menus, purchases, stock or kitchen data |
| Catering Director (DC / Head Chef) | Menus, daily quantities, kitchens, quality and hygiene checks, delivery schedule and quantities, stock use and losses, purchase requests, replying to site feedback. Sees workers, attendance and finance | Assign workers, edit attendance, approve purchases, change finance |
| Sous-Chef (own kitchen only) | Record meals cooked and portioned, preparation, handovers, shortages, delays and quality issues; report stock problems | Change menus, stock or delivery schedules; HR or finance |
| Dishwashing, Sealing & Transport Team (own kitchen only) | Record cleaning, damaged equipment, portions, packaging, labels, loading, delivery, delays, losses and damaged packaging; report stock problems | HR, finance, menus, changing stock, attendance |

The document does not mention the medical, accommodation and HSE modules, so three more roles are kept for them:
**Medical Department**, **Accommodation Manager** and **HSE Manager**.

Every role is a list of ticked permissions. The Managing Director can change them on screen
(*Users & Settings → Roles & permissions*) and create new roles; changes apply immediately. The Managing Director role
always keeps full access. Each person sees only the menus and buttons their role allows, and the server refuses
anything else even if someone tries to go around the screens. Sous-chefs and the transport team must be given their
kitchen, and Site Administrators their sites, under *Users & Settings → Users*.

**Upgrading from the first version.** Pushing this version to Heroku updates the database by itself: new tables and
columns are added, the old "Super Administrator" role becomes "Managing Director (MD / DG)", and the old default roles
(Management / Director, Human Resources, Site Manager, Catering Department, Kitchen Manager, Accounting / Finance) are
removed if nobody uses them. **Users who still have an old role keep it; give them one of the new roles** under
*Users & Settings → Users*, then delete the old role.

**Enter once, use everywhere.** Attendance entered by a Site Administrator feeds the dashboard, meals, payroll,
overtime and cost sharing without being typed again.

---

## 4. Security

- Passwords are stored scrambled (bcrypt); sign-ins expire after 12 hours; after 20 sign-in attempts from one device, it must wait 15 minutes.
- Every screen and every server request checks the user's permissions and sites.
- The site is forced onto https (encrypted) on Heroku.
- An audit log records who created, changed, deleted, confirmed or viewed sensitive records (*Users & Settings → Audit log*).
- The database is never reachable from the website; only the server talks to it.

---

## 5. Things to know before going live

- **Database size.** The free JawsDB plan is very small (5 MB) and is only for trying the system. Photos and documents
  are stored inside the database (Heroku does not keep uploaded files on its own disk), so choose a paid JawsDB plan
  for real use.
- **Backups.** Check in the JawsDB dashboard (`heroku addons:open jawsdb`) that your plan includes automatic backups,
  and turn them on. You can also make your own copy any time with `mysqldump` using the address in `JAWSDB_URL`.
- **"No direct Internet access to MySQL".** On normal Heroku, add-on databases such as JawsDB are reachable over the
  Internet, protected by a password. If the client needs the database to be completely private, the database must sit
  in a private network (Heroku Private Spaces, or a private cloud database such as AWS RDS in a private network).
  The app does not need any change for that; only `DATABASE_URL` changes.
- **Check two settings** under *Users & Settings → Settings*. They were set to a guess: currency **XAF** and time zone
  **Africa/Douala** (used to check the 09:00 daily report deadline). Change them if the company works elsewhere.
  The major-expense limit (1,000,000) and the report deadline (09:00) can be changed there too.
- **Offline use** needs the person to open the Attendance page once while online on that device, so the app and the
  worker list are saved there. It works in Chrome, Edge, Safari and Firefox on phones and computers. On a phone,
  use the browser's "Add to Home screen" to install it like an app.

---

## 6. What is where

```
database/schema.sql     All database tables (can be read on its own as the database design)
server/                 Node.js server
  index.js              Starts the server, serves the website
  migrate.js            Creates/updates tables and default roles
  seed-demo.js          Sample data
  lib/                  Database, sign-in, permissions, shared helpers
  routes/               One file per area (workers, attendance, catering, ...)
  test/                 Automatic checks
client/                 React website
  src/pages/            One file per screen
  src/lib/sync.js       Offline saving and automatic sending
  public/sw.js          Lets the app open without Internet
Procfile                Tells Heroku how to start the app and update the database
```
