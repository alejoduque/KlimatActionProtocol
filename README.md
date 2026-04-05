# KlimatActionProtocol

**Climate Action Protocol** is a free/libre software project based on arguman, redesigned and retooled specifically as an argument analysis and mapping platform for climate-related activism. 

## Permacomputing Philosophy

Climate Action Protocol embraces the principles of **Permacomputing Aesthetics**, a holistic approach to computation that centers resource efficiency, longevity, and sustainability over planned obsolescence. 

To align with this radical minimalism and minimize our ecological footprint:
- **No Social Media Integration:** Heavy tracking features and share embeds have been removed.
- **Frictionless Usage:** Intrusive, database-heavy traditional user accounts have been stripped. Users interact securely via frictionless guest UUID tracking ("Ghost Profiles").
- **Language & Resource Minimalism:** Refined to a clear, single-language interface to minimize background resource overhead.

By focusing on frugality, we ensure that our digital infrastructure directly respects the climate activism it seeks to facilitate.

*Credit & Reference: [Permacomputing Aesthetics](https://monoskop.org/images/6/6a/Mansoux_Aymeric_et_al_2023_Permacomputing_Aesthetics.pdf) by Aymeric Mansoux et al. (2023).*

## How does it work?

Users assert contentions to be discussed, supported, proved, or disproved, and argue with premises using because, but, or however conjunctions. By mapping these arguments visually, large-scale debates surrounding climate action can be evaluated effectively according to clarity, accuracy, and sound reasoning.

## Running Locally (Docker)

The easiest way to run the Climate Action Protocol locally is by using Docker.

1. Ensure you have [Docker](http://docker.io) and [Docker Compose](https://docs.docker.com/compose/install/) installed.
2. Navigate to `web/main` and create your local settings file:
   ```bash
   cp web/main/settings_local.py.ex web/main/settings_local.py
   ```
3. From the root directory, start the application:
   ```bash
   docker compose up -d
   ```
4. Access the platform on your local network at `http://localhost:8000`.

## License

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

## Credits 

Based on the open source project `arguman`. 
