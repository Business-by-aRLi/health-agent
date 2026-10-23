# Health Agent

סוכן אישי בטלגרם שמתנהג כמו מאמן כושר ותזונאי. הוא קורא נתונים מ-Apple Health דרך Health Auto Export, שומר אותם ב-Supabase, ומתחשב בתוכנית תזונה, בבדיקות דם ובתרופות.

- ארכיטקטורה: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- חיבור האייפון: [`docs/setup-health-auto-export.md`](docs/setup-health-auto-export.md)

## מבנה

```
supabase/migrations/   סכימה + RLS + פונקציות SQL (שמות הקבצים תואמים להיסטוריית המיגרציות בפרויקט)
supabase/functions/    Edge Functions (Deno). _shared/adapters = מתאם לכל מקור מידע
tests/                 בדיקות מתאם (Deno) + בדיקות אינטגרציה על Postgres מקומי
```

## בדיקות

```bash
deno task test       # מתאם Health Auto Export
deno task test:sql   # מיגרציות + RPC + RLS על Postgres זמני (דורש postgresql מקומי)
deno task check      # type-check
deno task lint
```
