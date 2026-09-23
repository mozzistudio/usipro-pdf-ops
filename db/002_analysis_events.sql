-- Le journal d'analyse d'une demande de chiffrage.
--
-- L'opérateur voit un prix, mais rien ne lui dit ce qui a été réellement lu
-- pour l'obtenir : un plan scanné sans couche texte, une image trop lourde
-- pour partir au modèle, une archive ouverte. Ces faits expliquent un prix
-- faux et ne survivaient jusqu'ici que dans les logs du serveur.
--
-- Une ligne est écrite au moment où le fait se produit et n'est jamais
-- modifiée : ce qui n'y est pas n'a pas eu lieu.
create table if not exists usipro.analysis_events (
  id         uuid primary key default gen_random_uuid(),
  work_id    text not null references usipro.works(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- L'ordre du récit à l'intérieur d'un lot : les pièces jointes sont lues en
  -- parallèle et reviennent dans le désordre. Entre deux lots — une analyse,
  -- puis un rechiffrage six mois plus tard — c'est l'horodatage qui tranche.
  position   integer not null default 0,
  stage      text not null check (stage in ('lecture','extraction','chiffrage')),
  -- La pièce jointe concernée, quand l'événement en vise une.
  file_name  text,
  level      text not null default 'info' check (level in ('info','warn','error')),
  message    text not null
);

comment on table usipro.analysis_events is
  'Journal d''analyse d''une demande de chiffrage : ce qui a été lu, ce que le modèle a extrait, ce que le calcul a supposé. En ajout seul — une ligne écrite n''est jamais modifiée.';

create index if not exists analysis_events_by_work
  on usipro.analysis_events (work_id, created_at, position);

alter table usipro.analysis_events enable row level security;
grant all on usipro.analysis_events to service_role;
