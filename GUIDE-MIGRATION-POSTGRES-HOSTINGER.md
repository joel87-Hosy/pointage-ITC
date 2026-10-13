# Migrer Pointage de Supabase vers PostgreSQL sur le VPS Hostinger

Ce guide déplace le stockage de l'application vers PostgreSQL installé sur le VPS. L'objectif est que l'application n'utilise ensuite ni Supabase ni Firebase.

## 1. Exporter les données Supabase

Dans Supabase, ouvre **Table Editor** → `public.pointages` → **Export** → **CSV**. Vérifie que toutes les colonnes sont exportées, notamment `id`, `badge_id`, `nom_agent`, `nom_normalise`, `code_agent`, `date`, `heure`, `type`, `device_id`, `user_agent`, `lat`, `lng`, `distance_m`.

Conserve l'export en lieu sûr. Il contient les données de présence des agents.

## 2. Installer PostgreSQL sur le VPS

Sur Ubuntu 22.04, installe PostgreSQL avec `apt`, vérifie le service, puis crée une base et un compte réservés à l'application. Configure PostgreSQL pour écouter uniquement en local (`127.0.0.1`), puisque l'application Node.js et la base sont sur le même VPS. Ne publie pas le port 5432 sur Internet.

Le compte `pointage_app` doit posséder la base et pouvoir créer la table `pointages` au premier démarrage de l'application.

## 3. Préparer une migration sans interruption prématurée

Avant l'import final, l'application hébergée sur l'ancien serveur peut continuer à recevoir des pointages. Pour éviter de perdre les derniers enregistrements :

1. Exporte une première fois le CSV et importe-le dans PostgreSQL local.
2. Compare les nombres de lignes et les ID maximum.
3. Au moment de la bascule, mets temporairement l'ancienne application en maintenance/lecture seule.
4. Réexporte les lignes nouvelles depuis Supabase (ou l'ensemble de la table), sauvegarde la base locale, puis importe le dernier lot. Le script fourni refuse volontairement une table locale non vide; pour un import incrémental, utilise un CSV ne contenant que les nouveaux ID et une procédure contrôlée.

## 4. Configurer l'application

Dans `/var/www/pointage-agent/.env`, configure `DATABASE_URL` vers `127.0.0.1:5432`, le nom de base et le compte local `pointage_app`. Mets `PGSSL=false` pour PostgreSQL local. Laisse `APP_URL`, `PORT`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` et `STATIC_QR_TOKEN` définis.

Redémarre l'app avec PM2, vérifie la connexion PostgreSQL, `/health`, les pages `/pointage`, `/kiosk` et `/admin`, puis teste un pointage de contrôle.

## 5. Sauvegardes

Avant de supprimer ou fermer l'ancien projet Supabase, garde un export CSV et une sauvegarde PostgreSQL (`pg_dump`). Vérifie qu'un `pg_restore` de cette sauvegarde fonctionne. Ne désactive Supabase qu'après validation de la base locale et de la bascule DNS.
