// The full list of permissions, and the default roles from "SYSTEM PRIVILEGES BY ROLE".
// Roles and their permissions can be changed later from the "Users & Settings" screen.
const PERMISSIONS = [
  ['dashboard.view', 'Dashboard', 'See the dashboard (sections depend on the other permissions)'],
  ['reports.all', 'Dashboard', 'See every dashboard section and company-wide figures'],

  ['structure.view', 'Organisation', 'See clients, projects and sites'],
  ['structure.manage', 'Organisation', 'Create and edit clients, projects and sites'],
  ['all_sites', 'Organisation', 'See every site (without this, only sites assigned to the user)'],

  ['workers.view', 'HR', 'See worker profiles and deployment'],
  ['workers.manage', 'HR', 'Create workers and edit their personal and job details'],
  ['workers.admin', 'HR', 'Edit administrative files: contracts, insurance, social security (CNSS), documents'],
  ['assignments.manage', 'HR', 'Assign, replace and move workers between sites; update worker status'],
  ['recruitment.manage', 'HR', 'Create job profiles and register candidates'],
  ['recruitment.verify', 'HR', 'Verify candidate documents (ID, qualifications)'],
  ['recruitment.approve', 'HR', 'Approve or reject candidate selection'],
  ['staffing.request', 'HR', 'Record client staffing requests on own sites and forward them to recruitment'],
  ['staffing.manage', 'HR', 'Handle staffing requests forwarded by sites'],

  ['attendance.view', 'Attendance', 'See attendance'],
  ['attendance.record', 'Attendance', 'Record presence, absence and overtime'],
  ['attendance.validate', 'Attendance', 'Submit the daily workforce report and resolve offline conflicts'],

  ['payroll.view', 'Payroll', 'See payroll figures'],
  ['payroll.manage', 'Payroll', 'Change pay rates, allowances and overtime rules'],

  ['catering.view', 'Catering', 'See all catering: meals needed, production, deliveries, feedback'],
  ['catering.manage', 'Catering', 'Calculate meals, plan daily quantities, manage kitchens and kitchen workflow'],
  ['menus.manage', 'Catering', 'Create and change menus'],
  ['quality.validate', 'Catering', 'Validate meal quality and hygiene of production batches'],
  ['dispatch.plan', 'Catering', 'Plan delivery schedules and validate dispatch quantities'],
  ['kitchen.view', 'Catering', 'See production plans, menus and deliveries of own kitchen'],
  ['kitchen.produce', 'Catering', 'Record ingredient preparation, meals cooked and portioned, handovers'],
  ['delivery.execute', 'Catering', 'Record loaded quantities and confirm delivery to sites'],
  ['ops.log', 'Catering', 'Record cleaning, damaged equipment, packaging, labelling, delays and losses'],
  ['all_kitchens', 'Catering', 'Work with every kitchen (without this, only kitchens assigned to the user)'],
  ['meals.receive', 'Catering', 'Record dishes received and meals distributed at own sites'],
  ['catering.feedback', 'Catering', 'Report delivery delays or complaints from own sites'],

  ['stock.view', 'Stock', 'See stock levels and movements'],
  ['stock.manage', 'Stock', 'Record stock received, used and lost'],
  ['stock.report', 'Stock', 'See stock levels of own kitchen and report shortages (cannot change stock)'],

  ['purchases.request', 'Purchases', 'Submit purchase requests'],
  ['purchases.approve', 'Purchases', 'Approve purchase requests up to the major-expense limit'],
  ['approvals.major', 'Purchases', 'Approve major expenses and purchases above the limit'],

  ['finance.view', 'Finance', 'See expenses, budgets and cost allocations'],
  ['finance.manage', 'Finance', 'Record expenses and allocate costs'],
  ['expenses.approve', 'Finance', 'Validate invoices, purchase orders and delivery notes'],
  ['budgets.manage', 'Finance', 'Create and edit budgets'],
  ['budgets.approve', 'Finance', 'Approve budgets'],

  ['accommodation.view', 'Accommodation', 'See accommodation and occupants'],
  ['accommodation.manage', 'Accommodation', 'Manage rooms, check-ins and check-outs'],

  ['medical.view', 'Medical', 'See medical records (confidential)'],
  ['medical.manage', 'Medical', 'Create and edit medical records (confidential)'],

  ['hse.view', 'HSE', 'See incidents and the HSE dashboard'],
  ['hse.report', 'HSE', 'Report incidents'],
  ['hse.manage', 'HSE', 'Manage incidents and corrective actions'],
  ['hse.approve', 'HSE', 'Approve completed corrective actions'],

  ['users.manage', 'Administration', 'Manage user accounts, roles and permissions'],
  ['settings.manage', 'Administration', 'Change company-wide settings'],
  ['audit.view', 'Administration', 'See the audit log'],
];

const ALL = PERMISSIONS.map((p) => p[0]);

// This role always has every permission and cannot be edited or deleted.
const FULL_ACCESS_ROLE = 'Managing Director (MD / DG)';

const ROLES = {
  [FULL_ACCESS_ROLE]: { description: 'Full access to every module, approval and setting', perms: ALL },

  'Finance & Administration Director (DAF)': {
    description: 'Finance, administration and HR records. Cannot assign workers, edit attendance or change catering production',
    perms: ['dashboard.view', 'reports.all', 'structure.view', 'all_sites', 'all_kitchens',
      'workers.view', 'workers.admin', 'recruitment.verify',
      'attendance.view', 'payroll.view', 'payroll.manage',
      'catering.view', 'stock.view',
      'purchases.approve', 'finance.view', 'finance.manage', 'expenses.approve', 'budgets.manage', 'budgets.approve', 'audit.view'],
  },

  'Recruitment Manager (RRJ / HR Casual Workers)': {
    description: 'Recruitment and deployment of workers. Cannot edit attendance, finance or catering',
    perms: ['dashboard.view', 'structure.view', 'all_sites',
      'workers.view', 'workers.manage', 'workers.admin', 'assignments.manage',
      'recruitment.manage', 'recruitment.verify', 'recruitment.approve', 'staffing.manage', 'attendance.view'],
  },

  'Site Administrator': {
    description: 'Attendance, incidents, client requests and meal receipt on own sites only',
    perms: ['dashboard.view', 'structure.view', 'attendance.view', 'attendance.record', 'attendance.validate',
      'hse.view', 'hse.report', 'staffing.request', 'meals.receive', 'catering.feedback'],
  },

  'Catering Director (DC / Head Chef)': {
    description: 'Menus, meal quantities, kitchen workflow, stock usage and deliveries. Cannot approve purchases or edit attendance, HR or finance',
    perms: ['dashboard.view', 'structure.view', 'all_sites', 'all_kitchens',
      'workers.view', 'attendance.view',
      'catering.view', 'catering.manage', 'menus.manage', 'quality.validate', 'dispatch.plan',
      'kitchen.view', 'kitchen.produce', 'ops.log',
      'stock.view', 'stock.manage', 'purchases.request', 'finance.view'],
  },

  'Sous-Chef': {
    description: 'Kitchen production for own kitchen. Cannot change menus, stock or delivery schedules',
    perms: ['dashboard.view', 'kitchen.view', 'kitchen.produce', 'stock.report'],
  },

  'Dishwashing, Sealing & Transport Team': {
    description: 'Cleaning, packaging, labelling and transport for own kitchen. No HR, finance or menus',
    perms: ['dashboard.view', 'kitchen.view', 'ops.log', 'delivery.execute', 'stock.report'],
  },

  // Not covered by the privileges document; kept so these modules still have an owner.
  'Medical Department': {
    description: 'Authorised medical information only',
    perms: ['dashboard.view', 'all_sites', 'workers.view', 'medical.view', 'medical.manage'],
  },
  'Accommodation Manager': {
    description: 'Accommodation and occupants',
    perms: ['dashboard.view', 'structure.view', 'all_sites', 'workers.view', 'accommodation.view', 'accommodation.manage'],
  },
  'HSE Manager': {
    description: 'Incidents and corrective actions',
    perms: ['dashboard.view', 'structure.view', 'all_sites', 'workers.view', 'hse.view', 'hse.report', 'hse.manage'],
  },
};

// Default roles from the first version. Removed automatically if nobody uses them.
const RETIRED_ROLES = ['Management / Director', 'Human Resources', 'Site Manager', 'Catering Department', 'Kitchen Manager', 'Accounting / Finance'];

const DEFAULT_SETTINGS = [
  ['overtime_multiplier', '1.5', 'Overtime pay = hourly rate x this number', 'payroll.manage'],
  ['standard_hours_per_day', '8', 'Normal working hours in one day (used to turn a daily rate into an hourly rate)', 'payroll.manage'],
  ['currency', 'XAF', 'Currency shown next to amounts', 'settings.manage'],
  ['major_expense_threshold', '1000000', 'Purchases and expenses above this amount need the Managing Director\'s approval', 'settings.manage'],
  ['daily_report_deadline', '09:00', 'Time by which sites must submit the daily workforce report', 'settings.manage'],
  ['company_timezone', 'Africa/Douala', 'Time zone used for deadlines (e.g. Africa/Douala, Africa/Lagos, Europe/Paris)', 'settings.manage'],
];

module.exports = { PERMISSIONS, ROLES, RETIRED_ROLES, FULL_ACCESS_ROLE, DEFAULT_SETTINGS };
