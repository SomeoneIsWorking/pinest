# PiNest

Control your Pi coding agents from your phone or laptop.

## Features

- 📱 Mobile-first web app
- 🔐 Google OAuth authentication
- 💬 Real-time chat with multiple agents
- 🖥️ Control agents across different project folders

## Tech Stack

- **Frontend:** Flutter (Web)
- **Backend:** Node.js
- **Auth:** Firebase Authentication
- **Database:** Firestore
- **Hosting:** Firebase Hosting

## Setup

### Prerequisites

- Flutter SDK
- Node.js
- Firebase CLI

### Development

```bash
# Install dependencies
flutter pub get

# Run locally
flutter run -d chrome

# Build for web
flutter build web
```

### Backend

```bash
cd backend
npm install
node server.js
```

## Deployment

Pushes to `main` touching `app/` auto-deploy to Firebase Hosting via
`.github/workflows/deploy-web.yml`. The workflow needs the repo secret
`FIREBASE_SERVICE_ACCOUNT` (service-account JSON with the Firebase Hosting
Admin role). Manual fallback: `flutter build web && firebase deploy --only
hosting` from `app/`.

## License

MIT
