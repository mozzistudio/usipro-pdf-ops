-- Les règles de l'atelier USI-PRO, telles que l'atelier les a données.
--
-- Jusqu'ici le moteur tournait sur des hypothèses de marché : un taux horaire
-- de PME, des tarifs matière au cours moyen, aucune machine. Ces valeurs-ci
-- sont les vraies — trois Haas, un taux de 75 €/h, des prix matière négociés —
-- et elles restent modifiables depuis l'écran de paramétrage : ce qui change
-- ici, c'est qu'elles ne sont plus devinées.
--
-- Les devis déjà chiffrés gardent leur prix : rien n'est recalculé dans le dos
-- de l'opérateur, il faut relancer le calcul sur la demande.

-- ── Ce que l'atelier sait faire, et avec quoi ────────────────────

alter table usipro.pricing_settings
  -- La programmation CAO n'est pas la mise en train : une pièce reprogrammée à
  -- l'identique ne se remonte pas, une pièce simple montée trois fois ne se
  -- reprogramme pas. Une heure pour une pièce simple, deux au maximum.
  add column if not exists programming_minutes      numeric(10,2) not null default 60,
  add column if not exists programming_minutes_max  numeric(10,2) not null default 120,

  -- Les courses du Haas VF4, la plus grande des trois machines. Une pièce qui
  -- n'y entre pas est à sous-traiter, et c'est avant le devis qu'il faut le
  -- savoir. En tournage, la question ne se pose pas.
  add column if not exists milling_travel_x_mm      numeric(10,2) not null default 1250,
  add column if not exists milling_travel_y_mm      numeric(10,2) not null default 500,
  add column if not exists milling_travel_z_mm      numeric(10,2) not null default 635,

  -- Tôlerie : une tôle fine et large part en débit, on ne fraise pas les deux
  -- faces. La facturer comme un bloc fraisé multipliait son prix.
  add column if not exists sheet_max_thickness_mm   numeric(10,2) not null default 20,
  add column if not exists sheet_min_format_mm      numeric(10,2) not null default 250,
  add column if not exists sheet_removal_ratio      numeric(6,3)  not null default 0.12,

  -- Une perpendicularité stricte ou un état de surface ne se rattrape pas au
  -- fraisage : on part d'un plat déjà rectifié, qui se paie.
  add column if not exists ground_aluminium_factor  numeric(6,2)  not null default 3,
  add column if not exists ground_inox_factor       numeric(6,2)  not null default 1.5;

-- 75 €/h : machine + opérateur, le taux de l'atelier.
update usipro.pricing_settings
   set hourly_rate = 75,
       updated_at  = now()
 where id = 'default'
   and hourly_rate = 65;   -- seulement si personne n'y a touché depuis

-- ── Les prix matière de l'atelier ────────────────────────────────

update usipro.material_rates set price_per_kg = 8,  updated_at = now() where id = 'inox';
update usipro.material_rates set price_per_kg = 12, updated_at = now() where id = 'aluminium';
update usipro.material_rates set price_per_kg = 30, updated_at = now() where id = 'laiton';
update usipro.material_rates set price_per_kg = 20, updated_at = now() where id = 'plastique';

-- Le PEHD est le seul plastique qui ne suit pas le tarif générique.
insert into usipro.material_rates (id, label, aliases, price_per_kg, density)
values ('pehd', 'PEHD', 'pehd,pe-hd,pe hd,polyethylene,polyéthylène haute densité', 10, 0.95)
on conflict (id) do update
  set price_per_kg = excluded.price_per_kg,
      aliases      = excluded.aliases,
      updated_at   = now();
