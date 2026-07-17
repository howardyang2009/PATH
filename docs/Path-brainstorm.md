# Path System

## Path software is a workflow management system.

## Path system include 
1. running engine that could run in multiple-platform, in ios, in android, in macOS, in windows, in linux, in Cloud (on Path website), write with Flutter(?)
2. one workflow description file format using json(?)
3. one online workflow design UI

## Path system workflow running status and input object, output object could be saved in 
1. local db and local storage
2. remote db and remote storage on Path website

## workflow design:
### input or output object could be 
	1. file (text or binary)
	2. prompt.md + context files
	3. one markdown file that include the link to outside URI
### one step have one input and one output.
### one workflow is structure by one checkpoint″ + (several sequential steps or several parallel steps) + maybe one logicor + one checkpoint
### one step could be 
	1. another workflow
	2. runable binary + configuration
	3. if one binary is not runable, it should provide a default function() entry
	4. one function in binary + configuration
	5. prompt about what need to do + context
	6. one API endpoint
	7. one MCP server
	8. one skill
	9. URI to upper type
### each step need to config a worker, one worker could be
	1. logal engine
	2. remote engine
	3. local LLM = subagent + one local LLM
	4. remote LLM = subagent + one remote LLM
	5. one physical company or person
### logicor type
	1. collect (for parallel steps, wait all step complete, and merge all step output to next step)
	2. wait-one (for parallel steps, wait on step complete, and tranfer that step output to next step)
	3. do-not-wait (for sequential or parallel steps, just star all head steps, then do not wait, continue to next step)
	4. branch logicor based on one value in input, branch start one of step
	5. while-do loop logicor based on one value in input, while-do loop start one workflow
### checkpoint
	1. write some logic to check data or context, if logic is wrong, stop process, is result is true, go to next step

## Path System provide pre-defined
### workflow template
### step template
1. default config
2. default worker
### if do not specify, the upper worker and config will be inherited by downside step

### one step + one target worker = one task

### One task running instance is one run 

### one worker instance = one processor
1. one local process
2. one thread in process
3. one docker container
4. one local LLM chat session
5. one remote LLM chat session
6. one person work period

## Path engine provide below support:
### logging-plugin, plugable logging include
	1. console
	2. local log file
	3. remote log file in Path website
	4. local db-log table
	5. rempte db-log table in Path website
### audit, using plugable logging to provide
	1. each run start time, end time, 
	2. each run processor id.
### context, each run have one global context, that shared by all steps in this workflow.
	1. IDictionary<id:string, value:object>
### configuration, each step will be inject on config object that could be different in each run
	1. IDictionary<id:string, value:object>

## Path Design
1. each time we just handle one workflow in UI, then contract that to a icon, then handle connnection with other steps in the upper level workflow, but also just one workflow in one time,
2. workflows are organized in hierchy method. 


## features
### todo list today
### schedule - map workflow to timeline
### workflow run path opatinization
1. early bird - complete one task as soon as possible
2. lazy - just did one task when it really needed



## version 2
### transaction
### 可以把一个流程生成为一个本地文件，快速完成一个流程， 这是可以把audit关掉，log也可以关掉
### 提供chatbot界面生成流程


