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
