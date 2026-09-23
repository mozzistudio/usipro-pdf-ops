-- USI-PRO internal — schéma `usipro`, rejoué à l'identique depuis Orkasa.
-- Seule adaptation : pgrst.db_schemas ne liste plus `seo`, qui appartenait à
-- l'application hôte et n'existe pas ici.

create schema if not exists usipro;

create table if not exists usipro.feedback (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  operation   text not null check (operation in ('anonymize','correct-page','usipro-table','plan-select')),
  verdict     text not null check (verdict in ('ok','ko')),
  comment     text not null default '',
  format      text,
  client      text,
  of_number   text,
  part_id     text,
  status      text not null default 'active' check (status in ('active','revoked'))
);

comment on table usipro.feedback is
  'Retours opérateur sur les opérations IA. Un retour actif portant un commentaire devient une consigne réinjectée dans les prompts suivants du même type.';

create index if not exists feedback_lookup on usipro.feedback (operation, status, created_at desc);
create index if not exists feedback_scope on usipro.feedback (format, client);

create table if not exists usipro.works (
  id            text primary key,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  tool          text not null check (tool in ('edition','chiffrage')),
  source        text not null check (source in ('form','email')),
  ref           text not null,
  status        text not null check (status in ('a_valider','livre')),
  client        text not null default '—',
  project       text,
  part_ids      text[] not null default '{}',
  plan_count    integer not null default 0,
  missing_parts text[] not null default '{}',
  dropbox_link  text,
  summary       text,
  details_in_attachments boolean not null default false,
  links         text[] not null default '{}'
);

comment on table usipro.works is
  'Index des travaux réalisés — ce que liste la home. Une ligne survit à la session de 30 minutes et au dépôt Dropbox.';
comment on column usipro.works.summary is
  'Ce que l''extraction a compris de la demande, en une phrase, affiché à l''opérateur.';
comment on column usipro.works.details_in_attachments is
  'Vrai quand le corps du mail renvoie aux pièces jointes: la demande existe, son contenu n''est pas encore lisible.';

create index if not exists works_recent on usipro.works (updated_at desc);
create index if not exists works_client on usipro.works (client);

create table if not exists usipro.work_files (
  id           uuid primary key default gen_random_uuid(),
  work_id      text not null references usipro.works(id) on delete cascade,
  created_at   timestamptz not null default now(),
  kind         text not null,
  part_id      text,
  file_name    text not null,
  storage_path text not null,
  byte_size    bigint not null default 0,
  constraint work_files_kind_check check (kind = any (array[
    'plan_anonymise', 'plan_original', 'devis_pdf', 'devis_docx', 'zip',
    'piece_jointe'
  ]))
);

create index if not exists work_files_by_work on usipro.work_files (work_id, created_at);

create table if not exists usipro.articles (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  client      text not null,
  reference   text not null,
  designation text,
  unique (client, reference)
);

comment on table usipro.articles is
  'Une pièce physique, vue du client qui la commande. Le rattachement s''appuie sur les empreintes des versions, pas sur cette référence.';

create table if not exists usipro.article_versions (
  id          uuid primary key default gen_random_uuid(),
  article_id  uuid not null references usipro.articles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  indice      text,
  step_data_sha256 text,
  entity_counts jsonb,
  bbox_mm       numeric[],
  point_count   integer,
  plan_sha256 text,
  cartouche   jsonb,
  source_of    text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists article_versions_by_article on usipro.article_versions (article_id, created_at desc);
create index if not exists article_versions_by_step    on usipro.article_versions (step_data_sha256);
create index if not exists article_versions_by_plan    on usipro.article_versions (plan_sha256);
create index if not exists article_versions_by_points  on usipro.article_versions (point_count);

create table if not exists usipro.quotes (
  id                 uuid primary key default gen_random_uuid(),
  article_version_id uuid not null references usipro.article_versions(id) on delete cascade,
  created_at         timestamptz not null default now(),
  of_number          text,
  quantity           integer,
  unit_price         numeric(12,4),
  setup_price        numeric(12,4),
  currency           text not null default 'EUR',
  quoted_at          timestamptz,
  source             text not null default 'inconnu'
                       check (source in ('historique_import','moteur','derogation','inconnu')),
  reference          text
);

create index if not exists quotes_by_version on usipro.quotes (article_version_id, quoted_at desc);
create index if not exists quotes_by_of on usipro.quotes (of_number);

create table if not exists usipro.request_lines (
  id          uuid primary key default gen_random_uuid(),
  work_id     text not null references usipro.works(id) on delete cascade,
  created_at  timestamptz not null default now(),
  position    integer not null default 0,
  reference   text,
  designation text,
  material    text,
  quantity    text,
  comment     text,
  unit_price numeric(12,4),
  total_price numeric(12,4),
  price_breakdown jsonb,
  price_computed_at timestamptz,
  status text not null default 'a_traiter'
    check (status in ('a_traiter', 'validee', 'forcee', 'manuelle', 'rejetee')),
  forced_price numeric(12,4),
  review_note text,
  reviewed_at timestamptz,
  alert_level text not null default 'vert'
    check (alert_level in ('vert', 'jaune', 'rouge')),
  alerts text[] not null default '{}'
);

create index if not exists request_lines_by_work on usipro.request_lines (work_id, position);
create index if not exists request_lines_by_status on usipro.request_lines (work_id, status);

create table if not exists usipro.client_pricing (
  client             text primary key,
  default_unit_price numeric(12,4),
  currency           text not null default 'EUR',
  note               text,
  updated_at         timestamptz not null default now()
);

comment on table usipro.client_pricing is
  'Prix unitaire par défaut par client — valeur posée à la main, jamais calculée. Remplacée par le moteur de coût le jour où il existe.';

create table if not exists usipro.pricing_settings (
  id                        text primary key default 'default',
  updated_at                timestamptz not null default now(),
  currency                  text not null default 'EUR',
  hourly_rate               numeric(10,2) not null default 65,
  setup_minutes             numeric(10,2) not null default 45,
  minutes_per_dm3           numeric(10,2) not null default 25,
  removal_ratio             numeric(6,3) not null default 0.45,
  learning_curve            numeric(6,3) not null default 0.90,
  margin_pct                numeric(6,2) not null default 20,
  handling_minutes_per_part numeric(10,2) not null default 3
);

comment on table usipro.pricing_settings is
  'Paramètres du moteur de coût. Valeurs livrées = hypothèses de départ, à corriger par l''atelier. Aucune n''est mesurée.';

create table if not exists usipro.material_rates (
  id          text primary key,
  label       text not null,
  aliases     text not null default '',
  price_per_kg numeric(10,2) not null,
  density      numeric(10,3) not null,
  updated_at   timestamptz not null default now()
);

comment on table usipro.material_rates is
  'Tarifs matière par nuance — ordres de grandeur du marché, à ajuster sur les factures réelles. La ligne "inconnu" sert de repli assumé et visible.';

alter table usipro.feedback         enable row level security;
alter table usipro.works            enable row level security;
alter table usipro.work_files       enable row level security;
alter table usipro.articles         enable row level security;
alter table usipro.article_versions enable row level security;
alter table usipro.quotes           enable row level security;
alter table usipro.request_lines    enable row level security;
alter table usipro.client_pricing   enable row level security;
alter table usipro.pricing_settings enable row level security;
alter table usipro.material_rates   enable row level security;

grant usage on schema usipro to service_role;
grant all on all tables in schema usipro to service_role;
alter default privileges in schema usipro grant all on tables to service_role;

insert into storage.buckets (id, name, public)
values ('usipro-files', 'usipro-files', false)
on conflict (id) do nothing;

alter role authenticator set pgrst.db_schemas = 'public, graphql_public, usipro';
notify pgrst, 'reload config';
