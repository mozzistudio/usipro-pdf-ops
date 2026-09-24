-- Le paramétrage de l'atelier : ce sur quoi tous les prix reposent.
--
-- Jusqu'ici le moteur tenait dans une ligne de `pricing_settings` : un taux
-- horaire unique, des courses de fraiseuse écrites en dur dans les colonnes,
-- et rien qui dise d'où venait une valeur ni qui l'avait changée. L'atelier
-- ne travaille pas comme ça : un tour et un centre 5 axes ne se facturent pas
-- au même taux, le parc évolue, et une règle de chiffrage naît d'un
-- commentaire de revue avant d'être une règle.
--
-- Deux principes traversent ces tables :
--   — rien n'entre dans le calcul sans validation explicite. Une règle
--     proposée reste proposée tant qu'un humain ne l'a pas activée ;
--   — l'historique est en ajout seul. Un retour à une version antérieure
--     écrit une version de plus, il n'en efface aucune : six mois plus tard,
--     l'écart entre deux devis doit rester explicable.

-- ── Les paramètres du moteur, au cas où ──────────────────────────
--
-- `003_atelier_usipro.sql` a déjà posé ces colonnes. On les repose ici sans
-- rien écraser : cet écran les rend modifiables, et une base migrée dans le
-- désordre ne doit pas laisser l'écran écrire dans des colonnes absentes.
alter table usipro.pricing_settings
  add column if not exists programming_minutes       numeric(10,2) not null default 60,
  add column if not exists programming_minutes_max   numeric(10,2) not null default 120,
  add column if not exists milling_travel_x_mm       numeric(10,2) not null default 1250,
  add column if not exists milling_travel_y_mm       numeric(10,2) not null default 500,
  add column if not exists milling_travel_z_mm       numeric(10,2) not null default 635,
  add column if not exists sheet_max_thickness_mm    numeric(10,2) not null default 20,
  add column if not exists sheet_min_format_mm       numeric(10,2) not null default 250,
  add column if not exists sheet_removal_ratio       numeric(6,3)  not null default 0.12,
  add column if not exists ground_aluminium_factor   numeric(6,2)  not null default 3,
  add column if not exists ground_inox_factor        numeric(6,2)  not null default 1.5;

-- ── Les taux horaires, par opération ─────────────────────────────
--
-- `applies_to` n'est pas décoratif : c'est lui qui relie un taux à la gamme
-- choisie par le moteur. Un taux que le moteur ne sait pas rattacher ('autre')
-- s'affiche à l'atelier sans entrer dans un prix — mieux vaut un taux visible
-- et inerte qu'un taux appliqué en silence à la mauvaise pièce.
create table if not exists usipro.operation_rates (
  id            text primary key,
  label         text not null,
  rate_per_hour numeric(10,2) not null,
  applies_to    text not null default 'autre'
                check (applies_to in ('tournage','fraisage_3','fraisage_5','debit_tole','reglage','autre')),
  position      integer not null default 0,
  updated_at    timestamptz not null default now()
);

comment on table usipro.operation_rates is
  'Taux horaires par opération. `applies_to` relie le taux à la gamme retenue par le moteur ; ''autre'' s''affiche sans entrer dans aucun prix.';

-- Les quatre taux partent tous du taux unique en vigueur, et non de valeurs
-- inventées : le jour de la migration, aucun prix ne doit bouger. C'est
-- l'atelier qui écrit ensuite ce que coûte vraiment une heure de 5 axes.
insert into usipro.operation_rates (id, label, rate_per_hour, applies_to, position)
select v.id, v.label, coalesce(s.hourly_rate, 75), v.applies_to, v.position
  from (values
    ('tournage_cn',    'Tournage CN',         'tournage',   0),
    ('fraisage_3axes', 'Fraisage 3 axes',     'fraisage_3', 1),
    ('fraisage_5axes', 'Fraisage 5 axes',     'fraisage_5', 2),
    ('reglage',        'Réglage / démarrage', 'reglage',    3)
  ) as v(id, label, applies_to, position)
  left join usipro.pricing_settings s on s.id = 'default'
on conflict (id) do nothing;

-- ── Le parc machines ─────────────────────────────────────────────
--
-- Les courses vivaient dans `pricing_settings` comme trois nombres sans
-- machine derrière. Or « la pièce ne passe pas » est un constat qui se rend à
-- l'atelier en nommant la machine : trois colonnes anonymes ne le permettent
-- pas, et le jour où une quatrième fraiseuse arrive, il n'y a pas de place où
-- l'écrire. Le moteur retient la plus grande capacité du parc.
create table if not exists usipro.machines (
  id              text primary key,
  label           text not null,
  kind            text not null default 'fraisage' check (kind in ('fraisage','tournage','autre')),
  axes            integer,
  travel_x_mm     numeric(10,1),
  travel_y_mm     numeric(10,1),
  travel_z_mm     numeric(10,1),
  max_diameter_mm numeric(10,1),
  max_length_mm   numeric(10,1),
  -- Deux machines identiques ne changent pas ce qui passe, seulement le débit.
  -- Le décompte est donc une information d'atelier, pas une entrée du calcul.
  count           integer not null default 1 check (count > 0),
  note            text,
  position        integer not null default 0,
  updated_at      timestamptz not null default now()
);

comment on table usipro.machines is
  'Le parc réel de l''atelier. Le moteur y lit la plus grande capacité pour dire si une pièce passe ; le décompte n''entre dans aucun prix.';

-- Le parc livré reprend les courses déjà paramétrées — celles du Haas VF4 —
-- pour qu'aucune pièce ne change de constat le jour de la migration. Les deux
-- autres machines de l'atelier et le tour s'ajoutent depuis l'écran, avec
-- leurs vraies capacités : le moteur ne les invente pas.
insert into usipro.machines (id, label, kind, axes, travel_x_mm, travel_y_mm, travel_z_mm, max_diameter_mm, max_length_mm, count, position)
select 'centre_3axes', 'Centre 3 axes', 'fraisage', 3,
       coalesce(s.milling_travel_x_mm, 1250),
       coalesce(s.milling_travel_y_mm, 500),
       coalesce(s.milling_travel_z_mm, 635),
       null, null, 1, 0
  from usipro.pricing_settings s where s.id = 'default'
on conflict (id) do nothing;

-- ── Les techniques ───────────────────────────────────────────────
--
-- Ce que l'atelier sait faire, ce qu'il sous-traite, ce qu'il ne fait pas. Le
-- moteur s'en sert pour une seule chose, mais elle compte : signaler une
-- demande qu'on ne peut pas honorer telle quelle, au lieu de la chiffrer comme
-- si elle passait.
create table if not exists usipro.techniques (
  id         text primary key,
  label      text not null,
  status     text not null default 'interne' check (status in ('interne','sous_traitee','non')),
  note       text,
  position   integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on table usipro.techniques is
  'Les techniques de l''atelier : internes, sous-traitées, ou hors du champ. Une technique ''non'' fait porter un constat à la ligne qui la réclame.';

insert into usipro.techniques (id, label, status, note, position) values
  ('tournage',       'Tournage CN',            'interne',      null,                              0),
  ('fraisage_3',     'Fraisage 3 axes',        'interne',      null,                              1),
  ('fraisage_5',     'Fraisage 5 axes',        'non',          'Repositionnement en 3 axes',      2),
  ('debit_tole',     'Débit tôle',             'interne',      null,                              3),
  ('rectification',  'Rectification',          'sous_traitee', 'Plats rectifiés achetés',         4),
  ('traitement',     'Traitements de surface', 'sous_traitee', 'Anodisation, passivation',        5)
on conflict (id) do nothing;

-- ── Les consignes générales ──────────────────────────────────────
--
-- Du texte libre, lu par le modèle au moment de l'extraction. Ce n'est pas un
-- pense-bête : une consigne active entre dans le prompt, une consigne retirée
-- n'y entre plus, et rien d'autre ne la fait agir.
create table if not exists usipro.instructions (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  text       text not null,
  status     text not null default 'active' check (status in ('active','retiree')),
  author     text,
  position   integer not null default 0
);

comment on table usipro.instructions is
  'Consignes générales de l''atelier, réinjectées telles quelles dans le prompt d''extraction. Une consigne retirée cesse d''y entrer.';

-- ── Les règles de chiffrage ──────────────────────────────────────
--
-- Une règle naît d'un commentaire de revue : « sur deux faces opposées,
-- compte une seconde prise ». Elle reste `a_valider` — visible, sans effet —
-- jusqu'à ce qu'un humain l'active. C'est la seule barrière entre ce qu'un
-- technicien a dit une fois et ce que l'atelier applique à tous ses devis.
create table if not exists usipro.pricing_rules (
  id           text primary key,
  created_at   timestamptz not null default now(),
  text         text not null,
  status       text not null default 'a_valider' check (status in ('a_valider','active','rejetee','retiree')),
  origin       text not null default 'manuel' check (origin in ('revue','manuel')),
  -- La demande où le commentaire a été écrit : une règle doit pouvoir se
  -- relire dans le contexte qui l'a fait naître.
  work_id      text references usipro.works(id) on delete set null,
  author       text,
  decided_at   timestamptz,
  decided_by   text,
  -- La version du paramétrage où elle est entrée en vigueur.
  since_version integer
);

comment on table usipro.pricing_rules is
  'Règles de chiffrage issues de la revue. Une règle ''a_valider'' est visible et sans effet ; seule une règle ''active'' entre dans le prompt d''extraction.';

create index if not exists pricing_rules_status on usipro.pricing_rules (status, created_at desc);

-- ── L'historique du paramétrage ──────────────────────────────────
--
-- Une version par changement, avec l'instantané complet de ce qu'était le
-- paramétrage juste après. Revenir en arrière n'efface rien : on relit un
-- instantané et on l'écrit comme version suivante. L'historique ne recule
-- jamais, même quand le paramétrage recule.
create table if not exists usipro.parameter_versions (
  version    integer primary key generated always as identity,
  created_at timestamptz not null default now(),
  author     text,
  -- Ce qui a changé, en une ligne, telle qu'elle s'affiche dans l'historique.
  summary    text not null,
  -- D'où vient cette version : un changement ordinaire, ou un retour arrière.
  kind       text not null default 'modification' check (kind in ('modification','retour')),
  -- La version relue, quand c'est un retour arrière.
  restored_from integer,
  snapshot   jsonb not null
);

comment on table usipro.parameter_versions is
  'Historique du paramétrage, en ajout seul. Chaque ligne porte l''instantané complet d''après changement ; un retour arrière écrit une version de plus.';

create index if not exists parameter_versions_recent on usipro.parameter_versions (version desc);

alter table usipro.operation_rates    enable row level security;
alter table usipro.machines           enable row level security;
alter table usipro.techniques         enable row level security;
alter table usipro.instructions       enable row level security;
alter table usipro.pricing_rules      enable row level security;
alter table usipro.parameter_versions enable row level security;

grant all on usipro.operation_rates    to service_role;
grant all on usipro.machines           to service_role;
grant all on usipro.techniques         to service_role;
grant all on usipro.instructions       to service_role;
grant all on usipro.pricing_rules      to service_role;
grant all on usipro.parameter_versions to service_role;
