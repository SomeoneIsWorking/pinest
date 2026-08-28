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

Push to `main` branch to auto-deploy to Firebase Hosting.

## License

MIT
