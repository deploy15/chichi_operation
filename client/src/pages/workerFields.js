import { opts } from '../lib/format';

export const WORKER_FIELDS = [
  { name: 'worker_code', label: 'Worker ID', required: true, help: 'Unique ID, e.g. W-00001' },
  { name: 'first_name', label: 'First name', required: true },
  { name: 'last_name', label: 'Last name', required: true },
  { name: 'status', label: 'Status', type: 'select', options: opts(['active', 'inactive', 'suspended', 'terminated']) },
  { name: 'gender', label: 'Gender', type: 'select', options: opts(['male', 'female', 'other']) },
  { name: 'date_of_birth', label: 'Date of birth', type: 'date' },
  { name: 'national_id', label: 'National ID / passport no.' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'address', label: 'Address', wide: true },
  { name: 'emergency_contact_name', label: 'Emergency contact' },
  { name: 'emergency_contact_phone', label: 'Emergency phone' },
  { name: 'job_position', label: 'Job position' },
  { name: 'category', label: 'Worker category', help: 'e.g. General, Skilled, Supervisory' },
  { name: 'pay_rate', label: 'Pay rate', type: 'number', min: 0 },
  { name: 'pay_rate_type', label: 'Paid per', type: 'select', options: [{ value: 'daily', label: 'Day' }, { value: 'hourly', label: 'Hour' }] },
];
