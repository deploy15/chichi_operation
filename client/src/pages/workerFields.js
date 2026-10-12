import { opts } from '../lib/format';

// Each group can only be changed by roles holding `perm` (the server enforces the same rule).
const HR = 'workers.manage';
const ADMIN = 'workers.admin';
const PAY = 'payroll.manage';
const DEPLOY = 'assignments.manage';

export const DEPLOYMENT = ['available', 'deployed', 'absent', 'unassigned'];

export const WORKER_FIELDS = [
  { name: 'worker_code', label: 'Worker ID', required: true, help: 'Unique ID, e.g. W-00001', perm: HR },
  { name: 'first_name', label: 'First name', required: true, perm: HR },
  { name: 'last_name', label: 'Last name', required: true, perm: HR },
  { name: 'status', label: 'Employment status', type: 'select', options: opts(['active', 'inactive', 'suspended', 'terminated']), perm: HR },
  { name: 'deployment_status', label: 'Deployment status', type: 'select', options: opts(DEPLOYMENT), perm: DEPLOY },
  { name: 'gender', label: 'Gender', type: 'select', options: opts(['male', 'female', 'other']), perm: HR },
  { name: 'date_of_birth', label: 'Date of birth', type: 'date', perm: HR },
  { name: 'national_id', label: 'National ID / passport no.', perm: HR },
  { name: 'phone', label: 'Phone', perm: HR },
  { name: 'email', label: 'Email', type: 'email', perm: HR },
  { name: 'address', label: 'Address', wide: true, perm: HR },
  { name: 'emergency_contact_name', label: 'Emergency contact', perm: HR },
  { name: 'emergency_contact_phone', label: 'Emergency phone', perm: HR },
  { name: 'job_position', label: 'Job position', perm: HR },
  { name: 'category', label: 'Worker category', help: 'e.g. General, Skilled, Supervisory', perm: HR },
  { name: 'contract_type', label: 'Contract type', help: 'e.g. Daily, Fixed-term', perm: ADMIN },
  { name: 'contract_start', label: 'Contract start', type: 'date', perm: ADMIN },
  { name: 'contract_end', label: 'Contract end', type: 'date', perm: ADMIN },
  { name: 'cnss_number', label: 'Social security (CNSS) no.', perm: ADMIN },
  { name: 'insurance_provider', label: 'Insurance provider', perm: ADMIN },
  { name: 'insurance_policy', label: 'Insurance policy no.', perm: ADMIN },
  { name: 'insurance_expiry', label: 'Insurance expiry', type: 'date', perm: ADMIN },
  { name: 'pay_rate', label: 'Pay rate', type: 'number', min: 0, perm: PAY },
  { name: 'pay_rate_type', label: 'Paid per', type: 'select', options: [{ value: 'daily', label: 'Day' }, { value: 'hourly', label: 'Hour' }], perm: PAY },
  { name: 'daily_allowance', label: 'Daily allowance', type: 'number', min: 0, help: 'Paid for each day present', perm: PAY },
];

// Fields this user may change; the others are shown read-only.
export const workerFieldsFor = (can) => WORKER_FIELDS.map((f) => ({ ...f, readOnly: !can(f.perm) }));
