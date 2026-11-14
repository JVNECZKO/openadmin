# cPanel / DirectAdmin migration

Admin → **Migracja backupów** (`/admin/import`) imports a `.tar.gz` account backup
into an existing panel user.

## Supported

| Source | What is imported |
|---|---|
| cPanel `cpmove-*.tar.gz` | `homedir/public_html` → the domain document root; `dnszones/*.db` → panel DNS records; `mysql/*.sql` → a MariaDB database `${user}_${name}` |
| DirectAdmin backup | `backup/domains/<domain>/public_html` → document root; DNS and SQL as above |
| Generic tar.gz | zones/SQL are detected; website files land in the account |

A report lists domains, DNS records, file count, databases and everything skipped.

## Not imported

- mailbox passwords (create mailboxes again; passwords cannot be exported),
- cron jobs, PHP versions, SSL private keys, FTP passwords,
- cPanel addon/subdomain mapping is best-effort based on directory names.

## Limits and safety

- Browser upload: 7 MB (base64). For larger backups copy the file to
  `/var/lib/openadmin/imports/` over SFTP and provide the absolute path.
- Archives with absolute paths or `..` are refused.
- Extraction happens in a private temporary directory and is removed afterwards.
- Existing domains are not overwritten; imported DNS records replace records with the
  same name in that zone.
- Run a backup and check the report before switching DNS to the new server.
