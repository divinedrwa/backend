# Backend — features overview

REST **`/api`** capability summary. Implementation status can drift — verify against live code and tests where critical.

## Backend (REST `/api`)

- **Auth:** JWT login; username or email; bcrypt passwords; role checks  
- **Directory:** Users, villas/flats, resident management  
- **Money:** Maintenance bills/payments/management, bank accounts, monthly expenses  
- **Operations:** Complaints (+ analytics), vendors, notices  
- **Security / gate:** Gates, guard shifts, guard patrols, visitors, pre-approved visitors, parcels, incidents  
- **Facilities:** Amenities, amenity bookings, calendar, staff, vehicles, parking  
- **Governance:** Polls, documents  
- **Engagement:** Banners, notifications (in-app / push plumbing with Firebase Admin where configured)  
- **Facility ops:** SOS alerts, water supply, garbage collection (where modules exist)  
- **Mobile-first routers:** `/residents/*` (dashboard, profile, maintenance, visitors, parcels, complaints, amenities, vehicles, staff, …), `/guards/*` (shifts, visitors, parcels, patrols, …)

## Guard (API + partial UI)

Backend supports guard flows (shifts, visitors, parcels, patrols, incidents). **Flutter** may include guard placeholders; production guard UX may be web or future native builds — confirm `divine_app` routes before promising guard-only features.

## Related docs

- **Architecture:** [ARCHITECTURE.md](./ARCHITECTURE.md)  
- **Setup:** [DEVELOPMENT.md](./DEVELOPMENT.md)  
- **Billing contract (mobile):** [maintenance-billing-mobile-contract.md](./maintenance-billing-mobile-contract.md)  
- **Admin web features:** [../../frontend/docs/FEATURES.md](../../frontend/docs/FEATURES.md)  
- **Resident app features:** [../../divine_app/docs/FEATURES.md](../../divine_app/docs/FEATURES.md)  
- **Monorepo README:** [../../README.md](../../README.md)
