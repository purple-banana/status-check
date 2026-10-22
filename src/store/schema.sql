-- Idempotent: the worker applies this on every start.

create table if not exists providers (
  id           text primary key,
  name         text not null,
  category     text not null,
  url          text not null,
  source       text not null,
  config       jsonb not null default '{}',
  aliases      text[] not null default '{}',
  interval_sec integer not null default 60,
  enabled      boolean not null default true,
  -- null for the built-in catalog; reserved for checks that users add themselves.
  owner        text
);

-- Current state, one row per provider. Components hold only the non-operational ones.
create table if not exists provider_status (
  provider_id text primary key references providers (id) on delete cascade,
  status      text not null,
  summary     text not null default '',
  components  jsonb not null default '[]',
  fingerprint text not null default '',
  checked_at  timestamptz,
  changed_at  timestamptz,
  error       text,
  error_at    timestamptz
);

create table if not exists incidents (
  provider_id text not null references providers (id) on delete cascade,
  id          text not null,
  title       text not null,
  status      text not null,
  impact      text not null,
  url         text,
  components  text[] not null default '{}',
  updates     jsonb not null default '[]',
  started_at  timestamptz not null,
  updated_at  timestamptz not null,
  resolved_at timestamptz,
  primary key (provider_id, id)
);

create index if not exists incidents_active on incidents (provider_id) where resolved_at is null;
create index if not exists incidents_started on incidents (started_at desc);

-- Overall status transitions, for "when did it go down" questions.
create table if not exists status_changes (
  provider_id text not null references providers (id) on delete cascade,
  at          timestamptz not null default now(),
  status      text not null,
  primary key (provider_id, at)
);
