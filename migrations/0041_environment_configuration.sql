CREATE TABLE IF NOT EXISTS provider_connections (
  id serial PRIMARY KEY,
  provider text NOT NULL,
  label text NOT NULL,
  account_type text NOT NULL DEFAULT 'legacy',
  credential_ref text,
  status text NOT NULL DEFAULT 'active',
  scope text NOT NULL DEFAULT 'user',
  owner_user_id text,
  account_id text,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_provider ON provider_connections(provider);
CREATE INDEX IF NOT EXISTS idx_provider_connections_scope_owner ON provider_connections(scope, owner_user_id);

CREATE TABLE IF NOT EXISTS environment_source_bindings (
  id serial PRIMARY KEY,
  environment_id integer NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'github',
  connection_id integer REFERENCES provider_connections(id) ON DELETE SET NULL,
  owner text NOT NULL DEFAULT '',
  repo text NOT NULL DEFAULT '',
  branch text NOT NULL DEFAULT '',
  auto_deploy boolean NOT NULL DEFAULT false,
  code_indexing_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_environment_source_bindings_environment ON environment_source_bindings(environment_id);
CREATE INDEX IF NOT EXISTS idx_environment_source_bindings_connection ON environment_source_bindings(connection_id);
CREATE INDEX IF NOT EXISTS idx_environment_source_bindings_indexing_enabled ON environment_source_bindings(code_indexing_enabled);

CREATE TABLE IF NOT EXISTS environment_hosting_bindings (
  id serial PRIMARY KEY,
  environment_id integer NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'railway',
  connection_id integer REFERENCES provider_connections(id) ON DELETE SET NULL,
  project_id text NOT NULL DEFAULT '',
  project_name text NOT NULL DEFAULT '',
  provider_environment_id text NOT NULL DEFAULT '',
  provider_environment_name text NOT NULL DEFAULT '',
  service_id text NOT NULL DEFAULT '',
  service_name text NOT NULL DEFAULT '',
  public_url text NOT NULL DEFAULT '',
  static_url text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_environment_hosting_bindings_environment ON environment_hosting_bindings(environment_id);
CREATE INDEX IF NOT EXISTS idx_environment_hosting_bindings_connection ON environment_hosting_bindings(connection_id);

CREATE TABLE IF NOT EXISTS environment_runtime_variables (
  id serial PRIMARY KEY,
  environment_id integer NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
  key text NOT NULL,
  category text NOT NULL DEFAULT 'runtime',
  required boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'manual',
  configured boolean NOT NULL DEFAULT false,
  secret_ref text,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_environment_runtime_variables_environment ON environment_runtime_variables(environment_id);
CREATE INDEX IF NOT EXISTS idx_environment_runtime_variables_key ON environment_runtime_variables(key);
