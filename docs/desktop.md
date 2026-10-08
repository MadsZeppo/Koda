# Koda Local

En lokal Electron-app oven på den eksisterende Koda CLI. Vælg mappe, skriv en selvstændig opgave, følg loggen og læs resultatet. Tidligere opgaver gemmes lokalt; de indgår ikke automatisk som modelkontekst.

Fra Koda-repository:

```sh
pnpm desktop
```

Installer en lokal macOS-launcher, der kan åbnes fra Finder:

```sh
pnpm desktop:install
open "$HOME/Applications/Koda Local.app"
```

Launcheren bruger denne checkout og dens installerede dependencies. Flyttes eller slettes Koda-repository, skal launcheren installeres igen. Dette er en personlig, usigneret udviklingsapp, ikke en distribueret release.

Backend skal allerede køre. Appens standardadresse er `http://127.0.0.1:8787`, som kan ændres i sidepanelet. Appen starter ikke backend eller håndterer dens OpenRouter-key. Child-processen bruger altid backend-mode og får ikke en lokal `OPENROUTER_API_KEY`.

Apply er synligt valgt som standard og bruger eksisterende CLI `--apply`: kun VERIFIED_SUCCESS kan anvendes, og eksisterende conflict/verification-regler bevares. Fravælg for preview. Resultatet viser apply-status separat. Rapportknappen åbner artefakterne, herunder kandidatpatchen når den findes.

Én opgave kører ad gangen i denne MVP. Vinduet kan ikke lukkes midt i en kørsel. Koda-pipelinens worker-parallelisme bevares. Der er ingen ny routing, visuel verification eller hastighedsgaranti i appen.
