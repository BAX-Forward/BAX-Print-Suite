# Clean-room research method

How BAX Print Suite learns what existing print workflows need without copying anyone's code.

## Roles
- **Observers** study existing tools only through their published documentation, their user-visible behaviour, and the output files they produce from our own test inputs. Observers write functional notes and never contribute implementation code for the area they observed.
- **Implementers** work only from the public specs in `docs/specs/`. They never see observation notes, screenshots or third-party files.

## What contributors must not do
Do not decompile, disassemble, debug, unpack or patch any third-party software, and do not work around licence checks or copy protection. Do not commit third-party code, assets, screenshots, manuals or output files. If you are unsure whether something is allowed, ask the maintainers before doing it.

## Pipeline
1. **Observe.** Record each piece of evidence with a short id, date and checksum: a documentation page, a behaviour you saw, an output file made from our own test input, or a response from a documented API.
2. **Write a functional spec.** Describe what the user can do and what output must result. Tag every statement *proven*, *inferred* or *unknown*, and cite the evidence ids behind it.
3. **Sanitize.** Remove product names, UI wording and anything not needed to state the requirement. Restate it in terms of public standards such as PDF, JDF/JMF, ICC profiles, HP-GL/2 or DXF. A second maintainer reviews it before it goes into `docs/specs/`.
4. **Implement** from the public spec only.
5. **Test differentially** (below).

## Black-box differential testing
- Build a corpus of test inputs we own: PDFs, vector cut contours and mixed jobs.
- Process each input with the reference workflow and with BPS. Keep the reference outputs out of the repository.
- Compare structure rather than bytes. For cut files, compare path geometry within a tolerance, the registration mark positions and the tool assignments. For PDFs, compare page boxes, separations and object counts. For colour, compare ΔE on rendered patches. For nesting, compare material yield and the number of sheets.
- Commit only the tolerances, the metrics and our own inputs. A failing comparison becomes an issue that cites the spec requirement.

## Useful public references
The ISO 32000 (PDF), CIP4 JDF/JMF, ICC and HP-GL/2 specifications, plus device manuals published for integrators. Wherever a public standard defines behaviour, prefer it over anything observed.
