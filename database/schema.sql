-- =====================================================================
-- ChiChi Workforce & Operations Management System - MySQL 8 schema
--
-- Safe to run more than once: every table uses CREATE TABLE IF NOT EXISTS.
-- Run it with:  npm run migrate   (or paste into any MySQL client)
--
-- Structure:  Company -> Clients -> Projects -> Sites -> Workers
-- History rule: assignments, kitchen assignments, room occupancies and
-- attendance changes are never overwritten - new rows are added instead.
-- =====================================================================

-- ---------- Organisation ----------
CREATE TABLE IF NOT EXISTS companies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS clients (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  contact_name VARCHAR(120) NULL,
  contact_email VARCHAR(150) NULL,
  contact_phone VARCHAR(40) NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_clients_code (code),
  CONSTRAINT fk_clients_company FOREIGN KEY (company_id) REFERENCES companies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS projects (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id INT UNSIGNED NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  location VARCHAR(200) NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  status ENUM('planned','active','on_hold','completed') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_projects_code (code),
  KEY ix_projects_client (client_id),
  CONSTRAINT fk_projects_client FOREIGN KEY (client_id) REFERENCES clients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sites (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  location VARCHAR(200) NULL,
  status ENUM('active','inactive','closed') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sites_code (code),
  KEY ix_sites_project (project_id),
  CONSTRAINT fk_sites_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Users, roles and permissions ----------
CREATE TABLE IF NOT EXISTS roles (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS permissions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(60) NOT NULL,
  module VARCHAR(40) NOT NULL,
  description VARCHAR(255) NOT NULL,
  UNIQUE KEY uq_permissions_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INT UNSIGNED NOT NULL,
  permission_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_perm FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(150) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role_id INT UNSIGNED NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sites a user is responsible for (used for site managers)
CREATE TABLE IF NOT EXISTS user_sites (
  user_id INT UNSIGNED NOT NULL,
  site_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, site_id),
  CONSTRAINT fk_us_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_us_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Workers ----------
CREATE TABLE IF NOT EXISTS workers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  worker_code VARCHAR(30) NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  gender ENUM('male','female','other') NULL,
  date_of_birth DATE NULL,
  national_id VARCHAR(60) NULL,
  phone VARCHAR(40) NULL,
  email VARCHAR(150) NULL,
  address VARCHAR(255) NULL,
  emergency_contact_name VARCHAR(120) NULL,
  emergency_contact_phone VARCHAR(40) NULL,
  status ENUM('active','inactive','suspended','terminated') NOT NULL DEFAULT 'active',
  job_position VARCHAR(100) NULL,
  category VARCHAR(60) NULL,
  pay_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
  pay_rate_type ENUM('hourly','daily') NOT NULL DEFAULT 'daily',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_workers_code (worker_code),
  KEY ix_workers_name (last_name, first_name),
  KEY ix_workers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS worker_documents (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  worker_id INT UNSIGNED NOT NULL,
  doc_type VARCHAR(60) NOT NULL,
  doc_number VARCHAR(80) NULL,
  issue_date DATE NULL,
  expiry_date DATE NULL,
  notes VARCHAR(255) NULL,
  file_name VARCHAR(200) NULL,
  file_mime VARCHAR(100) NULL,
  file_data MEDIUMBLOB NULL,
  uploaded_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_wd_worker (worker_id),
  CONSTRAINT fk_wd_worker FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A worker can have many successive assignments. Rows are never deleted;
-- an assignment is closed by setting end_date / status = 'ended'.
CREATE TABLE IF NOT EXISTS worker_assignments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  worker_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NOT NULL,
  site_id INT UNSIGNED NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NULL,
  job_position VARCHAR(100) NULL,
  pay_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
  pay_rate_type ENUM('hourly','daily') NOT NULL DEFAULT 'daily',
  status ENUM('active','ended','cancelled') NOT NULL DEFAULT 'active',
  notes VARCHAR(255) NULL,
  end_reason VARCHAR(255) NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_by INT UNSIGNED NULL,
  ended_at DATETIME NULL,
  KEY ix_wa_worker (worker_id, start_date),
  KEY ix_wa_site_dates (site_id, start_date, end_date),
  KEY ix_wa_project (project_id),
  CONSTRAINT fk_wa_worker FOREIGN KEY (worker_id) REFERENCES workers(id),
  CONSTRAINT fk_wa_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_wa_site FOREIGN KEY (site_id) REFERENCES sites(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which meals an assignment entitles the worker to
CREATE TABLE IF NOT EXISTS meal_entitlements (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  assignment_id INT UNSIGNED NOT NULL,
  meal_type ENUM('lunch','dinner') NOT NULL,
  UNIQUE KEY uq_me (assignment_id, meal_type),
  CONSTRAINT fk_me_assignment FOREIGN KEY (assignment_id) REFERENCES worker_assignments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Attendance ----------
CREATE TABLE IF NOT EXISTS attendance (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid CHAR(36) NOT NULL,
  assignment_id INT UNSIGNED NOT NULL,
  worker_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NOT NULL,
  site_id INT UNSIGNED NOT NULL,
  work_date DATE NOT NULL,
  status ENUM('present','absent') NOT NULL,
  late_arrival TINYINT(1) NOT NULL DEFAULT 0,
  early_departure TINYINT(1) NOT NULL DEFAULT 0,
  normal_hours DECIMAL(5,2) NOT NULL DEFAULT 0,
  overtime_hours DECIMAL(5,2) NOT NULL DEFAULT 0,
  comments VARCHAR(500) NULL,
  validated TINYINT(1) NOT NULL DEFAULT 0,
  validated_by INT UNSIGNED NULL,
  validated_at DATETIME NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  source ENUM('online','offline') NOT NULL DEFAULT 'online',
  recorded_by INT UNSIGNED NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_att_uuid (uuid),
  UNIQUE KEY uq_att_assignment_date (assignment_id, work_date),
  KEY ix_att_site_date (site_id, work_date),
  KEY ix_att_worker_date (worker_id, work_date),
  KEY ix_att_project_date (project_id, work_date),
  CONSTRAINT fk_att_assignment FOREIGN KEY (assignment_id) REFERENCES worker_assignments(id),
  CONSTRAINT fk_att_worker FOREIGN KEY (worker_id) REFERENCES workers(id),
  CONSTRAINT fk_att_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_att_site FOREIGN KEY (site_id) REFERENCES sites(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every change to an attendance record (modification history)
CREATE TABLE IF NOT EXISTS attendance_history (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  op_id CHAR(36) NULL,
  change_type VARCHAR(30) NOT NULL,
  old_data JSON NULL,
  new_data JSON NULL,
  changed_by INT UNSIGNED NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ah_attendance (attendance_id),
  CONSTRAINT fk_ah_attendance FOREIGN KEY (attendance_id) REFERENCES attendance(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every operation received from a device. The op_id (UUID made on the device)
-- is the primary key, so the same operation can never be applied twice.
CREATE TABLE IF NOT EXISTS sync_operations (
  op_id CHAR(36) NOT NULL PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  device_id VARCHAR(64) NULL,
  entity VARCHAR(40) NOT NULL,
  entity_id INT UNSIGNED NULL,
  result ENUM('applied','conflict','rejected') NOT NULL,
  message VARCHAR(255) NULL,
  client_created_at DATETIME NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_so_user (user_id, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  op_id CHAR(36) NOT NULL,
  attendance_id INT UNSIGNED NULL,
  user_id INT UNSIGNED NULL,
  client_data JSON NOT NULL,
  server_data JSON NULL,
  status ENUM('open','kept_server','applied_device') NOT NULL DEFAULT 'open',
  resolved_by INT UNSIGNED NULL,
  resolved_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sc_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Catering ----------
CREATE TABLE IF NOT EXISTS kitchens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  kitchen_type ENUM('central','temporary') NOT NULL DEFAULT 'central',
  status ENUM('active','suspended','closed') NOT NULL DEFAULT 'active',
  project_id INT UNSIGNED NULL,
  location VARCHAR(200) NULL,
  travel_time_minutes INT UNSIGNED NULL,
  start_date DATE NULL,
  planned_close_date DATE NULL,
  actual_close_date DATE NULL,
  notes VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_k_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Kitchens a user manages (used for kitchen managers)
CREATE TABLE IF NOT EXISTS user_kitchens (
  user_id INT UNSIGNED NOT NULL,
  kitchen_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, kitchen_id),
  CONSTRAINT fk_uk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_uk_kitchen FOREIGN KEY (kitchen_id) REFERENCES kitchens(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which kitchen feeds which site, and when (full history kept)
CREATE TABLE IF NOT EXISTS site_kitchen_assignments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  site_id INT UNSIGNED NOT NULL,
  kitchen_id INT UNSIGNED NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NULL,
  notes VARCHAR(255) NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ska_site (site_id, start_date, end_date),
  KEY ix_ska_kitchen (kitchen_id),
  CONSTRAINT fk_ska_site FOREIGN KEY (site_id) REFERENCES sites(id),
  CONSTRAINT fk_ska_kitchen FOREIGN KEY (kitchen_id) REFERENCES kitchens(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kitchen_staff (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kitchen_id INT UNSIGNED NOT NULL,
  worker_id INT UNSIGNED NULL,
  name VARCHAR(120) NOT NULL,
  staff_role VARCHAR(80) NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  CONSTRAINT fk_ks_kitchen FOREIGN KEY (kitchen_id) REFERENCES kitchens(id),
  CONSTRAINT fk_ks_worker FOREIGN KEY (worker_id) REFERENCES workers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kitchen_id INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  unit VARCHAR(20) NOT NULL DEFAULT 'kg',
  quantity DECIMAL(12,3) NOT NULL DEFAULT 0,
  reorder_level DECIMAL(12,3) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_stock_item (kitchen_id, name),
  CONSTRAINT fk_si_kitchen FOREIGN KEY (kitchen_id) REFERENCES kitchens(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_movements (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stock_item_id INT UNSIGNED NOT NULL,
  movement_type ENUM('in','out','waste','adjustment') NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  movement_date DATE NOT NULL,
  reference VARCHAR(100) NULL,
  notes VARCHAR(255) NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sm_item (stock_item_id, movement_date),
  CONSTRAINT fk_sm_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Meals required per site, per day, per meal (calculated from validated attendance)
CREATE TABLE IF NOT EXISTS meal_orders (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  site_id INT UNSIGNED NOT NULL,
  kitchen_id INT UNSIGNED NULL,
  service_date DATE NOT NULL,
  meal_type ENUM('lunch','dinner') NOT NULL,
  required_qty INT UNSIGNED NOT NULL DEFAULT 0,
  calculated_by INT UNSIGNED NULL,
  calculated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mo (site_id, service_date, meal_type),
  KEY ix_mo_kitchen (kitchen_id, service_date),
  CONSTRAINT fk_mo_site FOREIGN KEY (site_id) REFERENCES sites(id),
  CONSTRAINT fk_mo_kitchen FOREIGN KEY (kitchen_id) REFERENCES kitchens(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Production plan per kitchen, per day, per meal
CREATE TABLE IF NOT EXISTS meal_plans (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kitchen_id INT UNSIGNED NOT NULL,
  service_date DATE NOT NULL,
  meal_type ENUM('lunch','dinner') NOT NULL,
  required_qty INT UNSIGNED NOT NULL DEFAULT 0,
  planned_qty INT UNSIGNED NOT NULL DEFAULT 0,
  menu VARCHAR(255) NULL,
  status ENUM('draft','confirmed','in_production','completed') NOT NULL DEFAULT 'draft',
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mp (kitchen_id, service_date, meal_type),
  CONSTRAINT fk_mp_kitchen FOREIGN KEY (kitchen_id) REFERENCES kitchens(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS production_batches (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  meal_plan_id INT UNSIGNED NOT NULL,
  produced_qty INT UNSIGNED NOT NULL DEFAULT 0,
  rejected_qty INT UNSIGNED NOT NULL DEFAULT 0,
  produced_at DATETIME NOT NULL,
  notes VARCHAR(255) NULL,
  recorded_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_pb_plan (meal_plan_id),
  CONSTRAINT fk_pb_plan FOREIGN KEY (meal_plan_id) REFERENCES meal_plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dispatches (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  meal_plan_id INT UNSIGNED NULL,
  kitchen_id INT UNSIGNED NOT NULL,
  site_id INT UNSIGNED NOT NULL,
  service_date DATE NOT NULL,
  meal_type ENUM('lunch','dinner') NOT NULL,
  dispatched_qty INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('prepared','dispatched','received') NOT NULL DEFAULT 'prepared',
  vehicle VARCHAR(60) NULL,
  driver VARCHAR(120) NULL,
  dispatched_at DATETIME NULL,
  notes VARCHAR(255) NULL,
  recorded_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_d_site_date (site_id, service_date),
  KEY ix_d_kitchen_date (kitchen_id, service_date),
  CONSTRAINT fk_d_plan FOREIGN KEY (meal_plan_id) REFERENCES meal_plans(id),
  CONSTRAINT fk_d_kitchen FOREIGN KEY (kitchen_id) REFERENCES kitchens(id),
  CONSTRAINT fk_d_site FOREIGN KEY (site_id) REFERENCES sites(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Receipt confirmation at the site (one per dispatch)
CREATE TABLE IF NOT EXISTS deliveries (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  dispatch_id INT UNSIGNED NOT NULL,
  received_qty INT UNSIGNED NOT NULL DEFAULT 0,
  received_at DATETIME NOT NULL,
  received_by INT UNSIGNED NULL,
  condition_notes VARCHAR(255) NULL,
  UNIQUE KEY uq_delivery_dispatch (dispatch_id),
  CONSTRAINT fk_del_dispatch FOREIGN KEY (dispatch_id) REFERENCES dispatches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS meal_distributions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  site_id INT UNSIGNED NOT NULL,
  service_date DATE NOT NULL,
  meal_type ENUM('lunch','dinner') NOT NULL,
  distributed_qty INT UNSIGNED NOT NULL DEFAULT 0,
  notes VARCHAR(255) NULL,
  recorded_by INT UNSIGNED NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_md_site_date (site_id, service_date),
  CONSTRAINT fk_md_site FOREIGN KEY (site_id) REFERENCES sites(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS catering_expenses (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kitchen_id INT UNSIGNED NULL,
  expense_date DATE NOT NULL,
  category ENUM('food','supplier','transport','fuel','staff','energy','equipment','other') NOT NULL,
  supplier VARCHAR(150) NULL,
  description VARCHAR(255) NULL,
  amount DECIMAL(14,2) NOT NULL,
  reference VARCHAR(80) NULL,
  recorded_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ce_date (expense_date),
  KEY ix_ce_kitchen (kitchen_id),
  CONSTRAINT fk_ce_kitchen FOREIGN KEY (kitchen_id) REFERENCES kitchens(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- How each expense is shared out to Client -> Project -> Site
CREATE TABLE IF NOT EXISTS catering_cost_allocations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  expense_id INT UNSIGNED NOT NULL,
  client_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NOT NULL,
  site_id INT UNSIGNED NOT NULL,
  method ENUM('direct','meal_count','percentage','manual') NOT NULL,
  percentage DECIMAL(7,4) NULL,
  amount DECIMAL(14,2) NOT NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cca_expense (expense_id),
  KEY ix_cca_site (site_id),
  CONSTRAINT fk_cca_expense FOREIGN KEY (expense_id) REFERENCES catering_expenses(id) ON DELETE CASCADE,
  CONSTRAINT fk_cca_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_cca_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_cca_site FOREIGN KEY (site_id) REFERENCES sites(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Accommodation ----------
CREATE TABLE IF NOT EXISTS accommodation_facilities (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  location VARCHAR(200) NULL,
  notes VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS accommodation_buildings (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  facility_id INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  CONSTRAINT fk_ab_facility FOREIGN KEY (facility_id) REFERENCES accommodation_facilities(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS accommodation_rooms (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  building_id INT UNSIGNED NOT NULL,
  room_number VARCHAR(30) NOT NULL,
  capacity INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('available','maintenance','closed') NOT NULL DEFAULT 'available',
  notes VARCHAR(255) NULL,
  UNIQUE KEY uq_room (building_id, room_number),
  CONSTRAINT fk_ar_building FOREIGN KEY (building_id) REFERENCES accommodation_buildings(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who stays where. Check-out sets check_out_date; rows are kept as history.
CREATE TABLE IF NOT EXISTS room_occupancies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id INT UNSIGNED NOT NULL,
  worker_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NULL,
  check_in_date DATE NOT NULL,
  check_out_date DATE NULL,
  notes VARCHAR(255) NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ro_room (room_id, check_out_date),
  KEY ix_ro_worker (worker_id),
  CONSTRAINT fk_ro_room FOREIGN KEY (room_id) REFERENCES accommodation_rooms(id),
  CONSTRAINT fk_ro_worker FOREIGN KEY (worker_id) REFERENCES workers(id),
  CONSTRAINT fk_ro_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- HSE ----------
CREATE TABLE IF NOT EXISTS hse_incidents (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  occurred_at DATETIME NOT NULL,
  client_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NOT NULL,
  site_id INT UNSIGNED NOT NULL,
  location VARCHAR(200) NULL,
  person_worker_id INT UNSIGNED NULL,
  person_name VARCHAR(150) NULL,
  incident_type ENUM('injury','near_miss','property_damage','environmental','fire','vehicle','security','illness','other') NOT NULL,
  description TEXT NOT NULL,
  severity ENUM('low','medium','high','critical') NOT NULL,
  witnesses TEXT NULL,
  immediate_actions TEXT NULL,
  status ENUM('open','under_investigation','closed') NOT NULL DEFAULT 'open',
  reported_by INT UNSIGNED NULL,
  reported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME NULL,
  KEY ix_hse_site (site_id, occurred_at),
  KEY ix_hse_project (project_id, occurred_at),
  KEY ix_hse_status (status),
  CONSTRAINT fk_hse_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_hse_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_hse_site FOREIGN KEY (site_id) REFERENCES sites(id),
  CONSTRAINT fk_hse_worker FOREIGN KEY (person_worker_id) REFERENCES workers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hse_corrective_actions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  incident_id INT UNSIGNED NOT NULL,
  description VARCHAR(500) NOT NULL,
  responsible_name VARCHAR(150) NOT NULL,
  due_date DATE NOT NULL,
  status ENUM('open','in_progress','done') NOT NULL DEFAULT 'open',
  completed_at DATETIME NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_hca_incident (incident_id),
  KEY ix_hca_due (status, due_date),
  CONSTRAINT fk_hca_incident FOREIGN KEY (incident_id) REFERENCES hse_incidents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hse_attachments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  incident_id INT UNSIGNED NOT NULL,
  file_name VARCHAR(200) NOT NULL,
  file_mime VARCHAR(100) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  file_data MEDIUMBLOB NOT NULL,
  uploaded_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_hatt_incident (incident_id),
  CONSTRAINT fk_hatt_incident FOREIGN KEY (incident_id) REFERENCES hse_incidents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Medical (restricted: only roles with medical.* permissions) ----------
CREATE TABLE IF NOT EXISTS medical_records (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  worker_id INT UNSIGNED NOT NULL,
  record_type ENUM('examination','appointment','fitness','restriction','certificate','incident_followup') NOT NULL,
  record_date DATE NOT NULL,
  title VARCHAR(150) NOT NULL,
  provider VARCHAR(150) NULL,
  fitness_result ENUM('fit','fit_with_restrictions','unfit','pending') NULL,
  restriction_details VARCHAR(500) NULL,
  valid_until DATE NULL,
  status ENUM('scheduled','completed','cancelled','open','closed') NOT NULL DEFAULT 'completed',
  hse_incident_id INT UNSIGNED NULL,
  notes TEXT NULL,
  file_name VARCHAR(200) NULL,
  file_mime VARCHAR(100) NULL,
  file_data MEDIUMBLOB NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_mr_worker (worker_id, record_date),
  KEY ix_mr_type (record_type, status),
  CONSTRAINT fk_mr_worker FOREIGN KEY (worker_id) REFERENCES workers(id),
  CONSTRAINT fk_mr_incident FOREIGN KEY (hse_incident_id) REFERENCES hse_incidents(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- System ----------
CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(60) NOT NULL PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  description VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  action VARCHAR(40) NOT NULL,
  entity VARCHAR(60) NOT NULL,
  entity_id VARCHAR(40) NULL,
  details JSON NULL,
  ip VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit_entity (entity, entity_id),
  KEY ix_audit_user (user_id, created_at),
  KEY ix_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
