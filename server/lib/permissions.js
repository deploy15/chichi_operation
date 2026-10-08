// The full list of permissions, and the default roles from the requirements (section 15).
// Roles and their permissions can be changed later from the "Users & Roles" screen.
const PERMISSIONS = [
  ['dashboard.view', 'Dashboard', 'See the management dashboard'],
  ['structure.view', 'Organisation', 'See clients, projects and sites'],
  ['structure.manage', 'Organisation', 'Create and edit clients, projects and sites'],
  ['all_sites', 'Organisation', 'See every site (without this, only sites assigned to the user)'],
  ['workers.view', 'Workers', 'See worker records'],
  ['workers.manage', 'Workers', 'Create and edit workers and their documents'],
  ['assignments.manage', 'Workers', 'Assign workers to projects and sites, set meal entitlements'],
  ['attendance.view', 'Attendance', 'See attendance'],
  ['attendance.record', 'Attendance', 'Record daily attendance'],
  ['attendance.validate', 'Attendance', 'Validate attendance and resolve sync conflicts'],
  ['payroll.view', 'Payroll', 'See payroll figures based on attendance'],
  ['catering.view', 'Catering', 'See meal requirements, kitchens and meal tracking'],
  ['catering.manage', 'Catering', 'Calculate meals, plan production, manage kitchens and kitchen assignments'],
  ['kitchen.manage', 'Catering', 'Record production, stock, dispatches for assigned kitchens'],
  ['all_kitchens', 'Catering', 'Work with every kitchen (without this, only kitchens assigned to the user)'],
  ['meals.receive', 'Catering', 'Confirm meal deliveries and record meals distributed at a site'],
  ['accommodation.view', 'Accommodation', 'See accommodation and occupants'],
  ['accommodation.manage', 'Accommodation', 'Manage rooms, check-ins and check-outs'],
  ['medical.view', 'Medical', 'See medical records (confidential)'],
  ['medical.manage', 'Medical', 'Create and edit medical records (confidential)'],
  ['hse.view', 'HSE', 'See incidents and the HSE dashboard'],
  ['hse.report', 'HSE', 'Report incidents'],
  ['hse.manage', 'HSE', 'Manage incidents and corrective actions'],
  ['finance.view', 'Finance', 'See expenses and cost allocations'],
  ['finance.manage', 'Finance', 'Record expenses and allocate costs'],
  ['users.manage', 'Administration', 'Manage users, roles and permissions'],
  ['audit.view', 'Administration', 'See the audit log'],
];

const ALL = PERMISSIONS.map((p) => p[0]);

const ROLES = {
  'Super Administrator': { description: 'Full system access', perms: ALL },
  'Management / Director': {
    description: 'Overall information, dashboards and reports',
    perms: ['dashboard.view', 'structure.view', 'all_sites', 'workers.view', 'attendance.view', 'payroll.view', 'catering.view', 'all_kitchens', 'accommodation.view', 'hse.view', 'finance.view', 'audit.view'],
  },
  'Human Resources': {
    description: 'Worker management and assignments',
    perms: ['dashboard.view', 'structure.view', 'all_sites', 'workers.view', 'workers.manage', 'assignments.manage', 'attendance.view', 'attendance.validate', 'payroll.view', 'accommodation.view'],
  },
  'Site Manager': {
    description: 'Only their assigned sites and workers',
    perms: ['dashboard.view', 'structure.view', 'workers.view', 'attendance.view', 'attendance.record', 'attendance.validate', 'hse.view', 'hse.report', 'meals.receive', 'catering.view'],
  },
  'Catering Department': {
    description: 'Attendance needed for meal calculations and catering operations',
    perms: ['dashboard.view', 'structure.view', 'all_sites', 'attendance.view', 'catering.view', 'catering.manage', 'kitchen.manage', 'all_kitchens', 'meals.receive'],
  },
  'Kitchen Manager': {
    description: 'Production, stock and distribution for their assigned kitchen',
    perms: ['dashboard.view', 'structure.view', 'all_sites', 'catering.view', 'kitchen.manage'],
  },
  'Accommodation Manager': {
    description: 'Accommodation and occupants',
    perms: ['dashboard.view', 'structure.view', 'all_sites', 'workers.view', 'accommodation.view', 'accommodation.manage'],
  },
  'Medical Department': {
    description: 'Authorised medical information only',
    perms: ['dashboard.view', 'all_sites', 'workers.view', 'medical.view', 'medical.manage'],
  },
  'HSE Manager': {
    description: 'Incidents and corrective actions',
    perms: ['dashboard.view', 'structure.view', 'all_sites', 'workers.view', 'hse.view', 'hse.report', 'hse.manage'],
  },
  'Accounting / Finance': {
    description: 'Costs, expenses and cost allocations',
    perms: ['dashboard.view', 'structure.view', 'all_sites', 'all_kitchens', 'catering.view', 'payroll.view', 'finance.view', 'finance.manage'],
  },
};

const DEFAULT_SETTINGS = [
  ['overtime_multiplier', '1.5', 'Overtime pay = hourly rate x this number'],
  ['standard_hours_per_day', '8', 'Normal working hours in one day (used to turn a daily rate into an hourly rate)'],
  ['currency', 'USD', 'Currency shown next to amounts'],
];

module.exports = { PERMISSIONS, ROLES, DEFAULT_SETTINGS };
