# Déployer Pointage sur Hostinger

## Offre nécessaire

Cette application est un serveur Express/Node.js. Il faut une offre Hostinger qui prend en charge les applications Node.js (VPS ou offre Node.js compatible). L'hébergement Web mutualisé classique, qui ne sert que des sites PHP/statique, ne peut pas exécuter `server.js`.

## Base de données

Utilisez PostgreSQL et renseignez `DATABASE_URL` avec la chaîne de connexion fournie par votre base. L'application crée automatiquement la table `pointages` au premier démarrage. Vous pouvez utiliser PostgreSQL chez Hostinger si votre offre le propose, ou un service PostgreSQL externe. Gardez `PGSSL=true` pour une base distante avec SSL; mettez `PGSSL=false` uniquement si le fournisseur exige une connexion sans SSL.

Les données actuellement dans `pointages.json` sont locales et ne sont pas automatiquement copiées vers PostgreSQL. Avant la bascule, exportez-les et migrez-les séparément si elles doivent être conservées. Les identifiants Firebase ne sont pas nécessaires lorsque `DATABASE_URL` est configurée.

## Préparer le projet

1. Déployez le contenu du dépôt, sans `.env`, `node_modules/` ni clés privées.
2. Dans le gestionnaire d'applications Node.js de Hostinger, choisissez la racine du projet, le fichier de démarrage `server.js` et une version Node.js 18 ou supérieure.
3. Lancez l'installation des dépendances avec `npm install` (ou la commande d'installation proposée par Hostinger).
4. Ajoutez les variables ci-dessous dans la configuration de l'application, puis redémarrez-la.

```dotenv
APP_URL=https://votre-domaine.tld
ADMIN_USERNAME=un-identifiant-admin
ADMIN_PASSWORD=un-mot-de-passe-long-et-unique
DATABASE_URL=postgresql://utilisateur:mot-de-passe@hote:5432/base
PGSSL=true
```

`PORT` est fourni par Hostinger : ne le fixez pas dans le panneau si la plateforme le définit automatiquement. Si la plateforme exige un port statique, configurez la variable `PORT` correspondante.

## Domaine et vérification

Associez votre domaine à l'application dans hPanel et activez le certificat SSL. `APP_URL` doit correspondre à l'adresse HTTPS publique. Après le démarrage, vérifiez `https://votre-domaine.tld/health`, puis ouvrez `/pointage`, `/kiosk` et `/admin`.

L'URL publique sert à générer les liens et QR codes. Si elle change, mettez `APP_URL` à jour puis redémarrez l'application et régénérez/imprimez le QR statique si nécessaire. Configurez `STATIC_QR_TOKEN` pour garder le même code statique après redémarrage ou changement de domaine.

## Fichiers à fournir

- `badges.json` est facultatif; ajoutez-le au déploiement si le scan des badges doit retrouver les agents.
- Ne publiez jamais `.env`, `firebase-service-account.json` ou les mots de passe/chaînes de connexion dans le dépôt.
- Gardez une sauvegarde régulière de PostgreSQL. Le code et les fichiers locaux de l'instance ne remplacent pas une sauvegarde de la base.
