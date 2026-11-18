Contract Guard is an API Contract Registery where teams working for a product publish each version of their API's specification. The roll of Contract Guard is to find out the changes happening between versions, find out any potential breaking those changes could cause, tracking what services would be affected by that change, and if the changes are critical then stop them from publishing.

The users are Engineers who own APIs, engineers whose services call them, and platform leads

I Asked the PO some questions and these are the answers I got:

My answers are inlined. 


On Wed, Nov 18, 2026 at 6:36 PM Malay Shikhar Soni <malayshikhar2004@gmail.com> wrote:

On Wed, Nov 18, 2026 at 6:29 PM Malay Shikhar Soni <malayshikhar2004@gmail.com> wrote:
PO Questions(I have opted for option 1: Contract Guard):

1) About the request-response direction, in request, adding an optional field, making a required field optional, etc would usually be considered safe, so how does it need to be handled and flagged?

This should be thought through by the candidate.  

2) Do there need to be more flags other than "SAFE" and "DANGEROUS", for example a DEPRECATION flag which would that nothing breaks yet, but i potentially might in the future. 

A: Yes please think of future and if needed, please support.  

3) How are those changes ideally supposed to be handled where the change introduces some new element which doesnt break anything but isnt used either, and does the warning still need to propagate to all the other connected schemas in this cycle?

A: It depends on how you want to support this. Question is valid but depends on you totally. 

4)About graceful handling of errors/situtations, what should the response of the system incline to in situations where the pipeline fails or lacks information, like should it be fail-open in any scenario?

A: FAil Safe is better as system should tell if the pipeline failed or actual guard failed to do its job. 

5) Whenever a broken change is found, is the change supposed to be directly rejected by the system, or should some of them in any condition be passed for manual reviews for the leads

A: Notify the user about the failure



Must haves are:  
    Registering of services and their owners with their details.

    From the consumers point of view, the services that use an API should be able to register what they are using.

    Comparison of versions on what the API actually accepts and returns, not on how the file is organised.

    Everything like endpoints and methods, parameters, request and response fields should be compared.

    A proper changelog and history should be mainatained and shown in the interface, including attempts to publish with the change and the result.

    UI should also show whom a version would affect

The Data Model should for now include: services, consumers, publish_attempts, consumer_usages, versions and their schemas should be made.

The severities/flags i am going for now with are: DANGEROUS, WARNING, DEPRECATED, SAFE.

UI pages should for now include: list of services, a service page, a diff interface to view difference bewteen two versions, impact and metrics page

Tech stack: Node 20, Express 5, pg, js-yaml, docker